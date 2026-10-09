import puppeteer, {
  type Browser,
  type BrowserWorker,
  type HTTPRequest,
  type Page,
} from "@cloudflare/puppeteer";
import { type CandidatePreview, startCandidatePreview } from "./candidate-sandbox.ts";
import {
  BROWSER_DAILY_SECONDS,
  BROWSER_RESERVATION_SECONDS,
  BROWSER_SESSION_MS,
  type BrowserRun,
  type BrowserScenario,
  type BrowserStep,
  MAX_BROWSER_RUNS_PER_CANDIDATE,
} from "./check-semantics.ts";

/**
 * Candidate browser check in Browser Run (AGENTS.md sections 35, 44, 7.3). The composed app runs
 * in the Project Sandbox; the browser reaches it only through request interception: every request
 * to the preview host is answered by `containerFetch` into the Sandbox, every other request is
 * blocked. So the preview has no public URL and the browser has no other network access.
 *
 * Cost guards, all enforced before a session opens:
 * - one session per check run, closed after at most `BROWSER_SESSION_MS`;
 * - at most `MAX_BROWSER_RUNS_PER_CANDIDATE` runs per Candidate (retries included);
 * - at most `BROWSER_DAILY_SECONDS` per UTC day on the D1 meter, under the free 10 minutes.
 *
 * Fixture sign-in: the shop names its user in `x-user-id`. The proxy sets that header to the
 * scenario's current actor (alice owns, bob collaborates), so no page code needs to change.
 */

const PREVIEW_HOST = "candidate.preview.invalid";
const ORIGIN = `http://${PREVIEW_HOST}`;
const PREVIEW_READY_MS = 40_000;
const WAIT_MS = 8_000;
const MAX_SCREENSHOTS = 8;
const VIEWPORT = { width: 1000, height: 720 };
const DENIED = new Set([401, 403, 404, 410]);

type BrowserEnv = Pick<Env, "BROWSER" | "DB" | "EVIDENCE" | "SANDBOX" | "ARTIFACTS">;

const utcDay = () => new Date().toISOString().slice(0, 10);

// --- Free-limit guard ----------------------------------------------------------------------

/**
 * Reserves one browser run: the per-Candidate count (row `day = <candidateId>`) and
 * `BROWSER_RESERVATION_SECONDS` on today's `browser-seconds` meter. Null when either cap is
 * reached; nothing stays reserved then.
 */
async function reserveBrowserRun(db: D1Database, candidateId: string): Promise<string | null> {
  const seconds = await db
    .prepare(
      `INSERT INTO usage_counters (day, counter, count) VALUES (?, 'browser-seconds', ?)
       ON CONFLICT (day, counter) DO UPDATE SET count = count + ? WHERE count + ? <= ?
       RETURNING count`,
    )
    .bind(
      utcDay(),
      BROWSER_RESERVATION_SECONDS,
      BROWSER_RESERVATION_SECONDS,
      BROWSER_RESERVATION_SECONDS,
      BROWSER_DAILY_SECONDS,
    )
    .first<{ count: number }>();
  if (!seconds) {
    return `daily Browser Run guard reached (${BROWSER_DAILY_SECONDS} s per UTC day)`;
  }
  const runs = await db
    .prepare(
      `INSERT INTO usage_counters (day, counter, count) VALUES (?, 'browser-runs', 1)
       ON CONFLICT (day, counter) DO UPDATE SET count = count + 1 WHERE count + 1 <= ?
       RETURNING count`,
    )
    .bind(candidateId, MAX_BROWSER_RUNS_PER_CANDIDATE)
    .first<{ count: number }>();
  if (!runs) {
    await settleBrowserSeconds(db, 0);
    return `${MAX_BROWSER_RUNS_PER_CANDIDATE} browser runs per Candidate already used (section 44)`;
  }
  return null;
}

/** Settles today's reservation to the measured session seconds. Never below zero. */
async function settleBrowserSeconds(db: D1Database, usedSeconds: number) {
  const delta = usedSeconds - BROWSER_RESERVATION_SECONDS;
  if (delta === 0) return;
  await db
    .prepare(
      "UPDATE usage_counters SET count = MAX(0, count + ?) WHERE day = ? AND counter = 'browser-seconds'",
    )
    .bind(delta, utcDay())
    .run();
}

// --- Scenario runner -----------------------------------------------------------------------

class AssertError extends Error {}
class InfraError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertError(message);
}

type ApiCall = {
  actor: string;
  method: string;
  path: string;
  status: number;
  body: string | undefined;
  at: number;
};

type Session = {
  page: Page;
  actor: { id: string };
  calls: ApiCall[];
  proxyErrors: string[];
  shots: Uint8Array[];
  steps: BrowserStep[];
};

/** Answers preview requests from the Sandbox and blocks the rest of the network. */
function intercept(session: Session, preview: CandidatePreview) {
  return async (req: HTTPRequest) => {
    let url: URL;
    try {
      url = new URL(req.url());
    } catch {
      await req.abort("blockedbyclient").catch(() => undefined);
      return;
    }
    if (url.hostname !== PREVIEW_HOST) {
      await req.abort("blockedbyclient").catch(() => undefined);
      return;
    }
    const path = `${url.pathname}${url.search}`;
    const isApi = url.pathname.startsWith("/api/");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers())) {
      if (k !== "host" && k !== "content-length") headers[k] = v;
    }
    if (isApi) headers["x-user-id"] = session.actor.id;
    const method = req.method();
    const body = method === "GET" || method === "HEAD" ? undefined : req.postData();
    try {
      const res = await preview.fetch(path, { method, headers, body: body ?? null });
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (isApi) {
        session.calls.push({
          actor: session.actor.id,
          method,
          path,
          status: res.status,
          body,
          at: Date.now(),
        });
      }
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (k !== "content-length" && k !== "content-encoding" && k !== "transfer-encoding") {
          out[k] = v;
        }
      });
      await req.respond({ status: res.status, headers: out, body: Buffer.from(bytes) });
    } catch (error) {
      session.proxyErrors.push(`${method} ${path}: ${String(error).slice(0, 160)}`);
      await req.respond({ status: 502, body: "preview proxy error" }).catch(() => undefined);
    }
  };
}

async function shot(session: Session) {
  if (session.shots.length >= MAX_SCREENSHOTS) return;
  const png = await session.page.screenshot({ type: "png" });
  session.shots.push(new Uint8Array(png));
}

/** Runs one step. A failure stops the scenario; later steps count as not run. */
async function step(session: Session, name: string, fn: () => Promise<void>) {
  const started = Date.now();
  const errorsBefore = session.proxyErrors.length;
  try {
    await fn();
    session.steps.push({ name, ok: true, ms: Date.now() - started });
  } catch (error) {
    const proxy = session.proxyErrors.slice(errorsBefore);
    const message = String(error instanceof Error ? error.message : error).slice(0, 300);
    // Only a check the app answered can fail it; a broken path to the app is a gap.
    const assertFailure =
      proxy.length === 0 &&
      (error instanceof AssertError || (error instanceof Error && error.name === "TimeoutError"));
    session.steps.push({
      name,
      ok: false,
      failure: {
        kind: assertFailure ? "assert" : "infra",
        detail: proxy.length > 0 ? `${message} (proxy: ${proxy[0]})` : message,
      },
      ms: Date.now() - started,
    });
    throw error;
  }
}

async function goto(session: Session, path: string) {
  const res = await session.page
    .goto(`${ORIGIN}${path}`, { waitUntil: "domcontentloaded", timeout: WAIT_MS })
    .catch((error: unknown) => {
      // The preview did not load: the run could not observe the app.
      throw new InfraError(`open ${path}: ${String(error).slice(0, 200)}`);
    });
  if (!res) throw new InfraError(`no response for ${path}`);
  assert(res.status() < 400, `GET ${path} returned ${res.status()}`);
}

const testId = (id: string) => `[data-testid="${id}"]`;

async function countOf(page: Page, selector: string) {
  return page.$$eval(selector, (els) => els.length);
}

async function waitForCount(page: Page, selector: string, expected: number) {
  await page
    .waitForFunction(
      `document.querySelectorAll(${JSON.stringify(selector)}).length === ${expected}`,
      {
        timeout: WAIT_MS,
      },
    )
    .catch(async () => {
      throw new AssertError(
        `expected ${expected} × ${selector}, found ${await countOf(page, selector).catch(() => "?")}`,
      );
    });
}

/** Waits until the shop total starts with `<items> item(s),`. */
async function waitForItems(page: Page, items: number) {
  await page
    .waitForFunction(
      `/^${items} items?,/.test(document.querySelector("#total")?.textContent ?? "")`,
      { timeout: WAIT_MS },
    )
    .catch(() => {
      throw new AssertError(`cart total never showed ${items} items`);
    });
}

/** Text of the shop total, for example "2 items, $24.00", as items and cents. */
async function cartTotal(page: Page) {
  const text = await page.$eval(
    "#total",
    (el) => (el as unknown as { textContent: string | null }).textContent ?? "",
  );
  const match = /(\d+)\s+items?,\s*\$([\d,]+\.\d{2})/.exec(text);
  assert(match, `cart total not shown (got "${text.slice(0, 60)}")`);
  return {
    items: Number(match[1]),
    cents: Math.round(Number((match[2] ?? "0").replace(/,/g, "")) * 100),
  };
}

/** Minimal flow on the existing shop UI: catalog, add to cart, total, remove. */
const CART_STEPS = 4;
async function cartScenario(s: Session) {
  const { page } = s;
  let priceCents = 0;
  await step(s, "add first product to cart", async () => {
    const label = await page.$eval(
      "#products li",
      (el) => (el as unknown as { textContent: string | null }).textContent ?? "",
    );
    const price = /\$([\d,]+\.\d{2})/.exec(label)?.[1];
    assert(price, `no price in product row "${label.trim().slice(0, 60)}"`);
    priceCents = Math.round(Number(price.replace(/,/g, "")) * 100);
    await page.click("#products [data-add]");
    await waitForCount(page, "#cart li", 1);
  });
  await step(s, "cart total equals product price", async () => {
    await waitForItems(page, 1);
    const total = await cartTotal(page);
    assert(total.cents === priceCents, `total ${total.cents} ¢ != price ${priceCents} ¢`);
    await shot(s);
  });
  await step(s, "adding again doubles quantity and total", async () => {
    await page.click("#products [data-add]");
    await waitForItems(page, 2);
    const total = await cartTotal(page);
    assert(total.cents === 2 * priceCents, `total ${total.cents} ¢ != 2 × ${priceCents} ¢`);
  });
  await step(s, "remove empties the cart", async () => {
    await page.click("#cart [data-remove]");
    await waitForCount(page, "#cart li", 0);
    await waitForItems(page, 0);
    const total = await cartTotal(page);
    assert(total.cents === 0, `empty cart total ${total.cents} ¢`);
    await shot(s);
  });
}

/**
 * Section 35 Wishlist flow. Runs when the shop renders `[data-testid="wishlist"]`. UI hooks:
 * `wishlist-create`, `wishlist-share`, `wishlist-share-url` (input value, link href, or text),
 * `wishlist-add` (one per product), `wishlist-item`, `wishlist-remove` (one per item), and
 * `wishlist-revoke`. A write after revoke must be answered 401, 403, 404, or 410.
 */
const WISHLIST_STEPS = 8;
async function wishlistScenario(s: Session) {
  const { page } = s;
  let sharePath = "";
  let collaboratorWrite: ApiCall | undefined;
  await step(s, "owner creates a wishlist", async () => {
    await page.click(testId("wishlist-create"));
    await page.waitForSelector(testId("wishlist-share"), { timeout: WAIT_MS });
    await shot(s);
  });
  await step(s, "owner shares it with a link", async () => {
    await page.click(testId("wishlist-share"));
    const handle = await page.waitForSelector(testId("wishlist-share-url"), { timeout: WAIT_MS });
    const raw = await handle?.evaluate(
      (el) =>
        (el as unknown as { value?: string }).value ||
        el.getAttribute("href") ||
        ((el as unknown as { textContent: string | null }).textContent ?? "").trim(),
    );
    assert(raw, "share link is empty");
    const url = new URL(raw, ORIGIN);
    sharePath = `${url.pathname}${url.search}${url.hash}`;
    assert(sharePath !== "/", `share link "${raw.slice(0, 80)}" has no path`);
  });
  await step(s, "collaborator opens the share link", async () => {
    s.actor.id = "bob";
    await goto(s, sharePath);
    await page.waitForSelector(testId("wishlist-add"), { timeout: WAIT_MS });
    await shot(s);
  });
  await step(s, "collaborator adds two products", async () => {
    const before = s.calls.length;
    const adds = await page.$$(testId("wishlist-add"));
    assert(adds.length >= 2, `need 2 products to add, found ${adds.length}`);
    await adds[0]?.click();
    await waitForCount(page, testId("wishlist-item"), 1);
    await (await page.$$(testId("wishlist-add")))[1]?.click();
    await waitForCount(page, testId("wishlist-item"), 2);
    collaboratorWrite = s.calls
      .slice(before)
      .find((c) => c.actor === "bob" && c.method !== "GET" && c.status < 300);
    assert(collaboratorWrite, "no successful collaborator write reached the API");
  });
  await step(s, "collaborator removes one product", async () => {
    await page.click(testId("wishlist-remove"));
    await waitForCount(page, testId("wishlist-item"), 1);
    await shot(s);
  });
  await step(s, "owner view shows the collaborator change", async () => {
    s.actor.id = "alice";
    await goto(s, sharePath);
    await waitForCount(page, testId("wishlist-item"), 1);
  });
  await step(s, "owner revokes the link", async () => {
    const since = Date.now();
    await page.click(testId("wishlist-revoke"));
    const deadline = Date.now() + WAIT_MS;
    while (
      !s.calls.some(
        (c) => c.actor === "alice" && c.method !== "GET" && c.at >= since && c.status < 300,
      )
    ) {
      assert(Date.now() < deadline, "revoke did not reach the API with a success status");
      await new Promise((r) => setTimeout(r, 200));
    }
    await shot(s);
  });
  await step(s, "later collaborator write is denied", async () => {
    s.actor.id = "bob";
    const write = collaboratorWrite;
    assert(write, "no collaborator write to replay");
    // Replays the collaborator's earlier write from the page, as the collaborator.
    const status = await page.evaluate(
      async (method: string, path: string, body: string | null) => {
        const res = await fetch(path, {
          method,
          headers: { "content-type": "application/json" },
          ...(body === null ? {} : { body }),
        });
        return res.status;
      },
      write.method,
      write.path,
      write.body ?? null,
    );
    assert(DENIED.has(status), `write after revoke returned ${status}, expected denial`);
    await shot(s);
  });
}

type ApiResult = { status: number; text: string };

/** Calls the shop API from the page, so the request goes through the browser and the proxy. */
async function api(s: Session, method: string, path: string, body?: unknown): Promise<ApiResult> {
  const raw = await s.page.evaluate(
    async (m: string, p: string, b: string | null) => {
      const res = await fetch(p, {
        method: m,
        headers: { "content-type": "application/json" },
        ...(b === null ? {} : { body: b }),
      });
      return JSON.stringify({ status: res.status, text: await res.text() });
    },
    method,
    path,
    body === undefined ? null : JSON.stringify(body),
  );
  const result = JSON.parse(raw) as ApiResult;
  if (result.status === 502 && result.text === "preview proxy error") {
    throw new InfraError(`${method} ${path}: preview proxy error`);
  }
  return result;
}

function json<T>(r: ApiResult, what: string): T {
  try {
    return JSON.parse(r.text) as T;
  } catch {
    throw new AssertError(`${what}: response is not JSON (${r.status} ${r.text.slice(0, 60)})`);
  }
}

/** True when the API answered for a route it knows, as opposed to the framework's 404. */
const knowsRoute = (r: ApiResult) => r.status !== 404 || /"error"\s*:/.test(r.text);

/** Opens a page as the current actor for a screenshot. Status is checked by the API calls. */
async function view(s: Session, path: string) {
  await s.page
    .goto(`${ORIGIN}${path}`, { waitUntil: "domcontentloaded", timeout: WAIT_MS })
    .catch((error: unknown) => {
      throw new InfraError(`open ${path}: ${String(error).slice(0, 200)}`);
    });
  await shot(s);
}

type WishlistJson = {
  id: string;
  itemCount: number;
  items: { productId: string; addedBy: string }[];
};

/**
 * Section 35 flow through the Wishlist API when the shop has no Wishlist UI yet. Every call goes
 * from the browser page through the proxy as the current fixture user; JSON views are captured.
 */
const WISHLIST_API_STEPS = 8;
async function wishlistApiScenario(s: Session, created: ApiResult) {
  let id = "";
  let joinPath = "";
  let products: string[] = [];
  await step(s, "owner creates a wishlist", async () => {
    assert(
      created.status === 201,
      `create returned ${created.status}: ${created.text.slice(0, 80)}`,
    );
    id = json<WishlistJson>(created, "create").id;
    assert(typeof id === "string" && id.length > 0, "created wishlist has no id");
  });
  await step(s, "owner shares it with a link", async () => {
    const shared = await api(s, "POST", `/api/wishlists/${encodeURIComponent(id)}/share`);
    assert(shared.status === 201, `share returned ${shared.status}`);
    joinPath = json<{ joinPath?: string }>(shared, "share").joinPath ?? "";
    assert(
      joinPath.startsWith("/api/"),
      `share link "${joinPath.slice(0, 80)}" is not an API path`,
    );
  });
  const list = `/api/wishlists/${encodeURIComponent(id)}`;
  await step(s, "collaborator joins through the link", async () => {
    s.actor.id = "bob";
    const joined = await api(s, "POST", joinPath);
    assert(joined.status === 200, `join returned ${joined.status}`);
  });
  await step(s, "collaborator adds two products", async () => {
    const catalog = json<{ products: { id: string }[] }>(
      await api(s, "GET", "/api/products"),
      "products",
    );
    products = catalog.products.map((p) => p.id).slice(0, 2);
    assert(products.length === 2, "catalog has fewer than 2 products");
    for (const productId of products) {
      const added = await api(s, "POST", `${list}/items`, { productId });
      assert(added.status === 201, `add ${productId} returned ${added.status}`);
    }
  });
  await step(s, "collaborator removes one product", async () => {
    const removed = await api(
      s,
      "DELETE",
      `${list}/items/${encodeURIComponent(products[0] ?? "")}`,
    );
    assert(removed.status === 200, `remove returned ${removed.status}`);
    assert(json<WishlistJson>(removed, "remove").itemCount === 1, "remove did not leave 1 item");
    await view(s, list);
  });
  await step(s, "owner view shows the collaborator change", async () => {
    s.actor.id = "alice";
    const owner = await api(s, "GET", list);
    assert(owner.status === 200, `owner view returned ${owner.status}`);
    const items = json<WishlistJson>(owner, "owner view").items;
    assert(
      items.length === 1 && items[0]?.productId === products[1] && items[0]?.addedBy === "bob",
      `owner sees ${JSON.stringify(items).slice(0, 120)}`,
    );
    await view(s, list);
  });
  await step(s, "owner revokes the link", async () => {
    const revoked = await api(s, "DELETE", `${list}/share`);
    assert(revoked.status === 200, `revoke returned ${revoked.status}`);
  });
  await step(s, "later collaborator write is denied", async () => {
    s.actor.id = "bob";
    const write = await api(s, "POST", `${list}/items`, { productId: products[0] });
    assert(
      DENIED.has(write.status),
      `write after revoke returned ${write.status}, expected denial`,
    );
    await view(s, list);
  });
}

export type BrowserCheckResult = {
  run: BrowserRun;
  startedAt: string;
  completedAt: string;
  log: string;
  screenshotKeys: string[];
};

/**
 * Runs the browser check for one Candidate. Screenshots go to `<prefix>/screenshot-<n>.png`
 * (n from 1). Never throws for an expected failure: the result says what happened.
 */
export async function runBrowserCheck(
  env: BrowserEnv,
  input: {
    projectId: string;
    candidateId: string;
    commit: string;
    /** `evidence/<project>/<change>/<candidate>/<check>` */
    prefix: string;
  },
): Promise<BrowserCheckResult> {
  // Reset once the preview answers, so a Sandbox restore does not count against the check timeout.
  let startedAt = new Date().toISOString();
  const lines: string[] = [];
  const done = async (run: BrowserRun, screenshotKeys: string[] = []) => ({
    run,
    startedAt,
    completedAt: new Date().toISOString(),
    log: lines.join("\n"),
    screenshotKeys,
  });

  const refused = await reserveBrowserRun(env.DB, input.candidateId);
  if (refused) {
    lines.push(`refused: ${refused}`);
    return done({ kind: "refused", reason: refused });
  }

  let preview: CandidatePreview;
  try {
    preview = await startCandidatePreview(env, { ...input, readyMs: PREVIEW_READY_MS });
    lines.push(`preview: bun run dev on Sandbox port ${preview.port}`);
    startedAt = new Date().toISOString();
  } catch (error) {
    await settleBrowserSeconds(env.DB, 0);
    lines.push(`no preview: ${String(error)}`);
    return done({ kind: "no_preview", detail: String(error) });
  }

  let browser: Browser | undefined;
  const opened = Date.now();
  let sessionMs = 0;
  try {
    try {
      browser = await puppeteer.launch(env.BROWSER as unknown as BrowserWorker);
    } catch (error) {
      await settleBrowserSeconds(env.DB, 0);
      lines.push(`launch failed: ${String(error)}`);
      return done({ kind: "launch_failed", detail: String(error) });
    }
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    const session: Session = {
      page,
      actor: { id: "alice" },
      calls: [],
      proxyErrors: [],
      shots: [],
      steps: [],
    };
    await page.setRequestInterception(true);
    const proxy = intercept(session, preview);
    page.on("request", (req) => void proxy(req));

    let scenario: BrowserScenario = "cart";
    let total = 1 + CART_STEPS;
    const flow = (async () => {
      await step(session, "owner opens the shop", async () => {
        await goto(session, "/");
        await page.waitForSelector("#products [data-add]", { timeout: WAIT_MS });
        await shot(session);
      });
      if (await page.$(testId("wishlist"))) {
        scenario = "wishlist";
        total = 1 + WISHLIST_STEPS;
        await wishlistScenario(session);
      } else {
        // No Wishlist UI: run the section 35 flow through the API when the shop has it.
        const created = await api(session, "POST", "/api/wishlists", { name: "Browser check" });
        if (knowsRoute(created)) {
          scenario = "wishlist-api";
          total = 1 + WISHLIST_API_STEPS;
          await wishlistApiScenario(session, created);
        } else {
          await cartScenario(session);
        }
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), BROWSER_SESSION_MS);
    });
    const outcome = await Promise.race([
      flow.then(
        () => "done" as const,
        () => "stopped" as const,
      ),
      deadline,
    ]);
    clearTimeout(timer);
    flow.catch(() => undefined);
    sessionMs = Date.now() - opened;

    for (const s of session.steps) {
      lines.push(
        `${s.ok ? "pass" : `FAIL(${s.failure?.kind})`} ${s.name} [${s.ms} ms]${s.failure ? `: ${s.failure.detail}` : ""}`,
      );
    }
    lines.push(`scenario: ${scenario}; ${outcome}; session ${Math.ceil(sessionMs / 1000)} s`);
    for (const c of session.calls.filter((c) => c.method !== "GET")) {
      lines.push(`api: ${c.actor} ${c.method} ${c.path} -> ${c.status}`);
    }
    for (const e of session.proxyErrors) lines.push(`proxy error: ${e}`);

    // Screenshots after the session math: R2 writes do not hold the browser open.
    const keys: string[] = [];
    await browser.close().catch(() => undefined);
    browser = undefined;
    sessionMs = Date.now() - opened;
    for (const [i, png] of session.shots.entries()) {
      const key = `${input.prefix}/screenshot-${i + 1}.png`;
      const digest = await crypto.subtle.digest("SHA-256", png);
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      await env.EVIDENCE.put(key, png, {
        httpMetadata: { contentType: "image/png" },
        customMetadata: { contentHash: `sha256:${hash}` },
      });
      keys.push(key);
      lines.push(`screenshot ${i + 1}: ${key} sha256:${hash}`);
    }
    return done(
      {
        kind: "ran",
        scenario,
        steps: session.steps,
        total,
        deadlineHit: outcome === "deadline",
        screenshots: keys.length,
        sessionMs,
      },
      keys,
    );
  } finally {
    if (browser) {
      // A close that fails leaves the session to the 60 s idle timeout: meter it as such.
      const closed = await browser.close().then(
        () => true,
        () => false,
      );
      sessionMs = Date.now() - opened + (closed ? 0 : 60_000);
    }
    if (sessionMs > 0) await settleBrowserSeconds(env.DB, Math.ceil(sessionMs / 1000));
    await preview.stop();
  }
}
