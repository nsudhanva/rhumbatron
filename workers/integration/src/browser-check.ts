import { type Browser, chromium, type Page, type Route } from "playwright-core";
import { type CandidatePreview, startCandidatePreview } from "./candidate-sandbox.ts";
import {
  BROWSER_DAILY_SECONDS,
  BROWSER_RESERVATION_SECONDS,
  BROWSER_SESSION_MS,
  type BrowserRun,
  type BrowserStep,
  MAX_BROWSER_RUNS_PER_CANDIDATE,
} from "./check-semantics.ts";

/**
 * Candidate browser check in the browser service (Playwright server). The composed app runs
 * in the Project Sandbox; the browser reaches it only through request interception: every request
 * to the preview host is answered by `containerFetch` into the Sandbox, every other request is
 * blocked. So the preview has no public URL and the browser has no other network access.
 *
 * Cost guards, all enforced before a session opens:
 * - one session per check run, closed after at most `BROWSER_SESSION_MS`;
 * - at most `MAX_BROWSER_RUNS_PER_CANDIDATE` runs per Candidate (retries included);
 * - at most the `BROWSER_DAILY_SECONDS` binding (fallback: the constant, 500) per UTC day on the
 *   `browser-seconds` usage meter. Compose sets 3600 s.
 */

const PREVIEW_HOST = "candidate.preview.invalid";
const ORIGIN = `http://${PREVIEW_HOST}`;
const PREVIEW_READY_MS = 40_000;
const WAIT_MS = 8_000;
const MAX_SCREENSHOTS = 8;
const VIEWPORT = { width: 1000, height: 720 };

type BrowserEnv = Pick<
  Env,
  "BROWSER" | "DB" | "EVIDENCE" | "SANDBOX" | "ARTIFACTS" | "BROWSER_DAILY_SECONDS"
>;

const utcDay = () => new Date().toISOString().slice(0, 10);

/** This environment's daily guard: the binding when it is a positive integer, else the constant. */
const dailySeconds = (configured?: string) => {
  const n = Number(configured);
  return configured && Number.isInteger(n) && n > 0 ? n : BROWSER_DAILY_SECONDS;
};

// --- Free-limit guard ---------------------------------------------------------------------

/**
 * Reserves one browser run: the per-Candidate count (row `day = <candidateId>`) and
 * `BROWSER_RESERVATION_SECONDS` on today's `browser-seconds` meter. Null when either cap is
 * reached; nothing stays reserved then.
 */
async function reserveBrowserRun(
  db: D1Database,
  candidateId: string,
  dailyCap: number,
): Promise<string | null> {
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
      dailyCap,
    )
    .first<{ count: number }>();
  if (!seconds) {
    return `daily browser guard reached (${dailyCap} s per UTC day)`;
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
    return `${MAX_BROWSER_RUNS_PER_CANDIDATE} browser runs per Candidate already used`;
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

// --- Flow runner --------------------------------------------------------------------------

class AssertError extends Error {}
class InfraError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertError(message);
}

type Session = {
  page: Page;
  proxyErrors: string[];
  /** Uncaught errors in the app's own page scripts. */
  appErrors: string[];
  /** The app's own pages and assets that answered 4xx or 5xx (API routes not included). */
  failedLoads: string[];
  shots: Uint8Array[];
  steps: BrowserStep[];
};

/**
 * Fetches from the preview and follows same-preview redirects, as a browser does: 301, 302 and 303
 * turn a POST into a GET; 307 and 308 keep the method. An intercepted response cannot be a
 * redirect for the browser, so the browser gets the final response. At most 5 hops.
 */
async function followRedirects(
  preview: CandidatePreview,
  path: string,
  init: { method: string; headers: Record<string, string>; body: string | null },
): Promise<Response> {
  let current = { path, ...init };
  for (let hop = 0; ; hop++) {
    const res = await preview.fetch(current.path, current);
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location || hop >= 5) return res;
    const next = new URL(location, `${ORIGIN}${current.path}`);
    if (next.hostname !== PREVIEW_HOST) return res;
    const keep = res.status === 307 || res.status === 308;
    const headers = { ...current.headers };
    if (!keep) {
      delete headers["content-type"];
      delete headers["Content-Type"];
    }
    current = {
      path: `${next.pathname}${next.search}`,
      method: keep ? current.method : "GET",
      headers,
      body: keep ? current.body : null,
    };
  }
}

/** Answers preview requests from the Sandbox and blocks the rest of the network. */
function intercept(session: Session, preview: CandidatePreview) {
  return async (route: Route) => {
    const req = route.request();
    let url: URL;
    try {
      url = new URL(req.url());
    } catch {
      await route.abort("blockedbyclient").catch(() => undefined);
      return;
    }
    if (url.hostname !== PREVIEW_HOST) {
      await route.abort("blockedbyclient").catch(() => undefined);
      return;
    }
    const path = `${url.pathname}${url.search}`;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers())) {
      if (k !== "host" && k !== "content-length") headers[k] = v;
    }
    const method = req.method();
    const body = method === "GET" || method === "HEAD" ? undefined : req.postData();
    try {
      const res = await followRedirects(preview, path, { method, headers, body: body ?? null });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (k !== "content-length" && k !== "content-encoding" && k !== "transfer-encoding") {
          out[k] = v;
        }
      });
      if (
        (res.status >= 500 || (res.status >= 400 && !path.startsWith("/api/"))) &&
        !path.startsWith("/favicon.ico")
      ) {
        session.failedLoads.push(`${res.status} ${method} ${path}`);
      }
      await route.fulfill({ status: res.status, headers: out, body: Buffer.from(bytes) });
    } catch (error) {
      session.proxyErrors.push(`${method} ${path}: ${String(error).slice(0, 160)}`);
      await route.fulfill({ status: 502, body: "preview proxy error" }).catch(() => undefined);
    }
  };
}

async function shot(session: Session) {
  if (session.shots.length >= MAX_SCREENSHOTS) return;
  const png = await session.page.screenshot({ type: "png" });
  session.shots.push(new Uint8Array(png));
}

/** Runs one step. A failure stops the flow; later steps count as not run. */
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

/**
 * Flow for any app:
 * 1. The home page renders visible text.
 * 2. The API answers its health route (the app conventions, packages/protocol APP_CONVENTIONS).
 * 3. Every page the app links to opens, as a person reaches it: by a click from the page that
 *    links it (client routing) and by a direct load of its URL (a reload or a shared link). At
 *    most MAX_PAGES pages, breadth first from the home page. Each page must answer below 400 and
 *    show text. No page script may throw, and no page or asset of the app may answer 4xx or 5xx.
 */
const APP_STEPS = 3;
const MAX_PAGES = 8;
async function appFlow(s: Session) {
  const { page } = s;
  await step(s, "home page shows content", async () => {
    const text = await page.$eval(
      "body",
      (el) => (el as unknown as { innerText?: string }).innerText ?? "",
    );
    assert(text.trim().length > 0, "the home page has no visible text");
  });
  await step(s, "API health answers", async () => {
    const status = await apiStatus(s, "/api/health");
    assert(status === 200, `GET /api/health returned ${status}`);
  });
  await step(s, "every linked page opens, by click and by direct load", async () => {
    await explorePages(s);
    await shot(s);
  });
}

/** Same-origin page links of the current page, as paths. API routes and anchors are skipped. */
async function pageLinks(page: Page): Promise<string[]> {
  const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href") ?? ""));
  const paths = new Set<string>();
  for (const href of hrefs) {
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, `${ORIGIN}/`);
    } catch {
      continue;
    }
    if (url.hostname !== PREVIEW_HOST || url.pathname.startsWith("/api/")) continue;
    paths.add(`${url.pathname}${url.search}`);
  }
  return [...paths];
}

async function visibleText(page: Page): Promise<string> {
  return page.$eval("body", (el) => (el as unknown as { innerText?: string }).innerText ?? "");
}

/** A page whose whole text is a not-found message, as a bare server 404 or a router fallback. */
const NOT_FOUND = /^\s*(404\b|not found\b)/i;

/**
 * Waits until the page stops loading data (at most 5 s), so client-rendered text and links exist.
 * The short pause first lets a refetch that a click or a submit starts begin.
 */
async function settled(page: Page): Promise<void> {
  await page.waitForTimeout(400);
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
}

/** Fills and submits each form on the page once, with sample values, so the app creates data. */
const MAX_FORMS_PER_PAGE = 3;
async function submitForms(s: Session, path: string): Promise<void> {
  const { page } = s;
  const forms = page.locator("form");
  const count = Math.min(await forms.count(), MAX_FORMS_PER_PAGE);
  for (let i = 0; i < count; i++) {
    const form = forms.nth(i);
    if (!(await form.isVisible().catch(() => false))) continue;
    const fields = form.locator(
      "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea",
    );
    for (let f = 0; f < (await fields.count()); f++) {
      const field = fields.nth(f);
      if (!(await field.isEditable().catch(() => false))) continue;
      const type = ((await field.getAttribute("type")) ?? "text").toLowerCase();
      const value =
        type === "number"
          ? "12"
          : type === "email"
            ? "person@example.com"
            : type === "date"
              ? "2026-01-15"
              : type === "url"
                ? "https://example.com"
                : `Sample ${f + 1}`;
      await field.fill(value).catch(() => undefined);
    }
    for (const box of await form.locator("input[type=checkbox]").all())
      await box.check().catch(() => undefined);
    for (const select of await form.locator("select").all()) {
      const options = await select.locator("option").count();
      if (options > 1) await select.selectOption({ index: 1 }).catch(() => undefined);
    }
    const submit = form.locator("button[type=submit], input[type=submit]").first();
    const button = (await submit.count()) > 0 ? submit : form.locator("button").last();
    if (!(await button.isVisible().catch(() => false))) continue;
    await button.click({ timeout: WAIT_MS });
    await settled(page);
    const text = await visibleText(page);
    assert(text.trim().length > 0, `the page at ${path} shows no text after a form was submitted`);
  }
}

async function explorePages(s: Session) {
  const { page } = s;
  const seen = new Set<string>(["/"]);
  const queue: { path: string; from: string }[] = [];
  const enqueue = (links: string[], from: string) => {
    for (const path of links) {
      if (seen.has(path) || seen.size > MAX_PAGES) continue;
      seen.add(path);
      queue.push({ path, from });
    }
  };
  await goto(s, "/");
  await settled(page);
  await submitForms(s, "/");
  enqueue(await pageLinks(page), "/");
  for (let item = queue.shift(); item; item = queue.shift()) {
    const { path, from } = item;
    // By click: open the linking page and follow the link, as a person does.
    await goto(s, from);
    await settled(page);
    const link = page.locator(`a[href="${path}"], a[href="${ORIGIN}${path}"]`).first();
    if (await link.isVisible().catch(() => false)) {
      await link.click({ timeout: WAIT_MS });
      await page.waitForLoadState("domcontentloaded", { timeout: WAIT_MS });
      await settled(page);
      const clicked = await visibleText(page);
      assert(
        clicked.trim().length > 0,
        `the page at ${path} shows no text after a click from ${from}`,
      );
      assert(!NOT_FOUND.test(clicked), `the link to ${path} on ${from} opens a not-found page`);
    }
    // By direct load: a reload, a bookmark, or a shared link.
    await goto(s, path);
    await settled(page);
    const loaded = await visibleText(page);
    assert(loaded.trim().length > 0, `a direct load of ${path} shows no text`);
    assert(!NOT_FOUND.test(loaded), `a direct load of ${path} shows a not-found page`);
    await submitForms(s, path);
    enqueue(await pageLinks(page), path);
  }
  assert(s.appErrors.length === 0, `a page script threw: ${s.appErrors.slice(0, 2).join("; ")}`);
  assert(
    s.failedLoads.length === 0,
    `the app answered errors: ${[...new Set(s.failedLoads)].slice(0, 3).join("; ")}`,
  );
}

/** GETs an app API path from the page, so the request goes through the browser and the proxy. */
async function apiStatus(s: Session, path: string): Promise<number> {
  const raw = await s.page.evaluate(async (p: string) => {
    const res = await fetch(p);
    return JSON.stringify({ status: res.status, text: await res.text() });
  }, path);
  const result = JSON.parse(raw) as { status: number; text: string };
  if (result.status === 502 && result.text === "preview proxy error") {
    throw new InfraError(`GET ${path}: preview proxy error`);
  }
  return result.status;
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

  const refused = await reserveBrowserRun(
    env.DB,
    input.candidateId,
    dailySeconds(env.BROWSER_DAILY_SECONDS),
  );
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
      browser = await chromium.connect(
        (env.BROWSER as unknown as { wsEndpoint: string }).wsEndpoint,
        { timeout: 30_000 },
      );
    } catch (error) {
      await settleBrowserSeconds(env.DB, 0);
      lines.push(`launch failed: ${String(error)}`);
      return done({ kind: "launch_failed", detail: String(error) });
    }
    const page = await browser.newPage({ viewport: VIEWPORT });
    const session: Session = {
      page,
      proxyErrors: [],
      appErrors: [],
      failedLoads: [],
      shots: [],
      steps: [],
    };
    page.on("pageerror", (error) => session.appErrors.push(String(error.message).slice(0, 200)));
    await page.route("**/*", intercept(session, preview));

    const total = 1 + APP_STEPS;
    const flow = (async () => {
      await step(session, "open the app", async () => {
        await goto(session, "/");
        await shot(session);
      });
      await appFlow(session);
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
    lines.push(`${outcome}; session ${Math.ceil(sessionMs / 1000)} s`);
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
