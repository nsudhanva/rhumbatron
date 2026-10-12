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
  type BrowserStep,
  MAX_BROWSER_RUNS_PER_CANDIDATE,
} from "./check-semantics.ts";

/**
 * Candidate browser check in Browser Run. The composed app runs
 * in the Project Sandbox; the browser reaches it only through request interception: every request
 * to the preview host is answered by `containerFetch` into the Sandbox, every other request is
 * blocked. So the preview has no public URL and the browser has no other network access.
 *
 * Cost guards, all enforced before a session opens:
 * - one session per check run, closed after at most `BROWSER_SESSION_MS`;
 * - at most `MAX_BROWSER_RUNS_PER_CANDIDATE` runs per Candidate (retries included);
 * - at most the `BROWSER_DAILY_SECONDS` binding (fallback: the constant, 500) per UTC day on this
 *   environment's D1 meter. ADR 0017 sets 960 s, 80 % of the
 *   included 10 browser hours per month.
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
    return `daily Browser Run guard reached (${dailyCap} s per UTC day)`;
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
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers())) {
      if (k !== "host" && k !== "content-length") headers[k] = v;
    }
    const method = req.method();
    const body = method === "GET" || method === "HEAD" ? undefined : req.postData();
    try {
      const res = await preview.fetch(path, { method, headers, body: body ?? null });
      const bytes = new Uint8Array(await res.arrayBuffer());
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
 * Flow for any app: the home page renders visible text and the API answers its health route (the
 * app conventions, packages/protocol APP_CONVENTIONS).
 */
const APP_STEPS = 2;
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
      browser = await puppeteer.launch(env.BROWSER as unknown as BrowserWorker);
    } catch (error) {
      await settleBrowserSeconds(env.DB, 0);
      lines.push(`launch failed: ${String(error)}`);
      return done({ kind: "launch_failed", detail: String(error) });
    }
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    const session: Session = { page, proxyErrors: [], shots: [], steps: [] };
    await page.setRequestInterception(true);
    const proxy = intercept(session, preview);
    page.on("request", (req) => void proxy(req));

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
