/**
 * Single-person API journeys against a deployed environment: one person (the Clerk smoke user)
 * drives whole requests through the public API, with real planning, agents, Sandbox checks,
 * promotion, and live app releases. One function per journey A1 to A18 of the journey matrix.
 * Usage: bun scripts/journeys.ts prod [A1,A2,...|all]
 *
 * CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID must both be set in the environment, for the Clerk
 * instance of that environment. Nothing reads them from the Keychain, and nothing prints them.
 * The run signs in with a one-time sign-in token on the Clerk Frontend API (scripts/e2e.ts).
 *
 * Every journey prints one PASS or FAIL line with its evidence (IDs, statuses, reasons). Every
 * journey has a hard timeout. Every Project a journey creates is named `e2e-<journey>-<ts>` and is
 * removed at the end (`DELETE /v1/projects/:id`), also on failure or timeout; open Changes are
 * cancelled first, so no agent keeps working on a removed Project.
 *
 * Cost: goals are tiny, so one build is about 15 model calls, about $0.15, and a few Sandbox
 * minutes. At most 3 builds run at the same time. A1, A6, A12, A13, A14, A15, and A18 share one
 * built Project (the A1 counter app) and run in that order. Before each journey that builds, the
 * spend guard reads the meters (`GET /v1/projects/:id/cost`) and skips the journey when the
 * Anthropic month passes $40, Sandbox use passes 15 h, or fewer than 40 model calls are left today.
 * `bun run cost:report` shows the Dynamic Worker versions, which the API does not report.
 */

const apis: Record<string, string> = { prod: "https://api.rhumbatron.com" };

const environment = process.argv[2] ?? "";
const base = apis[environment] ?? "";
if (!base) {
  console.error(`Usage: bun scripts/journeys.ts <${Object.keys(apis).join("|")}> [A1,A2,...|all]`);
  process.exit(2);
}
const secretKey = process.env.CLERK_SECRET_KEY;
const smokeUserId = process.env.CLERK_SMOKE_USER_ID;
if (!secretKey || !smokeUserId) {
  console.error("CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID are required in the environment.");
  process.exit(2);
}

/** Builds that may run at the same time (the journey matrix). */
const MAX_PARALLEL_BUILDS = 3;
/** Spend guard limits. */
const MAX_ANTHROPIC_MONTH_USD = 40;
const MAX_SANDBOX_SECONDS_MONTH = 15 * 3600;
const MIN_MODEL_CALLS_LEFT_TODAY = 40;
const POLL_MS = 10_000;
/** A wait with no Change, Task, or Candidate movement for this long fails the journey. */
const NO_PROGRESS_MS = 10 * 60_000;
const MINUTE = 60_000;

/* ------------------------------------------------------------------------------------------ */
/* Clerk sign-in                                                                               */
/* ------------------------------------------------------------------------------------------ */

async function clerkBackend(method: string, path: string, body?: unknown) {
  const response = await fetch(`https://api.clerk.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

/**
 * A one-time sign-in token, redeemed on the Frontend API from the app origin, so the session
 * token carries `azp` like a browser session. Clerk session tokens live 60 seconds: one is reused
 * for at most 30 seconds.
 */
async function signIn() {
  const domains = await clerkBackend("GET", "/domains");
  const domain = (
    (domains.json.data ?? []) as { name: string; frontend_api_url: string; is_satellite: boolean }[]
  ).find((d) => !d.is_satellite);
  if (!domain) throw new Error(`Clerk domains returned ${domains.status} with no primary domain`);
  const origin = `https://${domain.name}`;
  const fapi = domain.frontend_api_url;
  const ticket = await clerkBackend("POST", "/sign_in_tokens", {
    user_id: smokeUserId,
    expires_in_seconds: 120,
  });
  if (ticket.status !== 200) throw new Error(`Clerk sign-in token returned ${ticket.status}`);
  const response = await fetch(`${fapi}/v1/client/sign_ins`, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ strategy: "ticket", ticket: ticket.json.token as string }),
    signal: AbortSignal.timeout(20_000),
  });
  const signed = (await response.json()) as {
    response?: { status?: string; created_session_id?: string };
  };
  const sessionId = signed.response?.created_session_id;
  if (response.status !== 200 || signed.response?.status !== "complete" || !sessionId) {
    throw new Error(`Clerk ticket sign-in returned ${response.status}`);
  }
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  let token = "";
  let mintedAt = 0;
  let minting: Promise<string> | null = null;
  const mint = async () => {
    const r = await fetch(`${fapi}/v1/client/sessions/${sessionId}/tokens`, {
      method: "POST",
      headers: { origin, cookie },
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await r.json()) as { jwt?: string };
    if (r.status !== 200 || !body.jwt) throw new Error(`Clerk session token returned ${r.status}`);
    token = body.jwt;
    mintedAt = Date.now();
    return token;
  };
  return {
    async token(): Promise<string> {
      if (token && Date.now() - mintedAt < 30_000) return token;
      // Journeys run in parallel: one mint at a time.
      minting ??= mint().finally(() => {
        minting = null;
      });
      return minting;
    },
    async close() {
      await clerkBackend("POST", `/sessions/${sessionId}/revoke`, {});
    },
  };
}

const session = await signIn();

/* ------------------------------------------------------------------------------------------ */
/* API types (the fields the journeys read)                                                    */
/* ------------------------------------------------------------------------------------------ */

type Outcome = {
  kind: string;
  reason: string | null;
  winnerChangeId: string | null;
  decidedBy: string | null;
};
type Question = { id: string; text: string; options?: string[] };
type Clarification = {
  kind: string;
  summary: string;
  questions: Question[];
  relatedChangeId: string | null;
  relatedGoal: string | null;
  round: number;
};
type ChangeView = {
  id: string;
  projectId: string;
  goal: string;
  status: string;
  budgetUsd: number;
  riskTier: string | null;
  blockedReason?: string | null;
  acceptanceCriteria: string[];
  baseGeneration: number;
  outcome?: Outcome | null;
  clarification?: Clarification | null;
  updatedAt: string;
};
type ReleaseView = {
  id: string;
  status: string;
  generation: number;
  commit: string;
  failureReason: string | null;
  candidateId: string;
};
type CandidateView = {
  id: string;
  changeId: string;
  status: string;
  statusReason: string | null;
  baseGeneration: number;
  composedTree: string | null;
  promotedGeneration: number | null;
  approvalRequired: boolean;
  approval: { decision: string } | null;
  release: ReleaseView | null;
  acceptance: { criterion: string; status: string }[] | null;
  plan: { checks: { checkId: string; kind: string; required: boolean }[] } | null;
  gate: { promotable: boolean; gaps: unknown[] } | null;
};
type TaskView = {
  id: string;
  key: string;
  status: string;
  runs: { status: string; tier: string; startedAt: string }[];
};
type AppView = {
  enabled: boolean;
  app: {
    label: string;
    url: string;
    status: string;
    commit: string | null;
    generation: number | null;
    failureReason: string | null;
  } | null;
  versions: { generation: number; url: string }[];
};
type Notification = {
  id: string;
  kind: string;
  projectId: string;
  changeId?: string;
  candidateId?: string;
  read: boolean;
};
type Meters = {
  agentModelCallsToday: number;
  agentDailyCallCap: number;
  anthropicSpentUsdMonth: number;
  sandboxSecondsMonth: number;
};

/* ------------------------------------------------------------------------------------------ */
/* Journey context, checks, and HTTP                                                           */
/* ------------------------------------------------------------------------------------------ */

class JourneyFailure extends Error {}

const runStart = Date.now();
const minutes = (ms: number) => `${(ms / MINUTE).toFixed(1)}m`;

class Ctx {
  readonly controller = new AbortController();
  readonly evidence: string[] = [];
  readonly projects: string[] = [];
  readonly started = Date.now();
  step = "start";
  /** Rejects when the journey is aborted, for `Promise.race` with the journey body. */
  readonly aborted: Promise<never>;

  constructor(readonly id: string) {
    this.aborted = new Promise<never>((_, reject) => {
      this.controller.signal.addEventListener("abort", () =>
        reject(new JourneyFailure(String(this.controller.signal.reason))),
      );
    });
    this.aborted.catch(() => {});
  }

  get signal() {
    return this.controller.signal;
  }

  log(message: string) {
    this.step = message;
    console.log(`  [${this.id} ${minutes(Date.now() - this.started)}] ${message}`);
  }

  /** Records a passed check as evidence; throws on a failed one. */
  check(ok: boolean, what: string, detail = "") {
    if (!ok) throw new JourneyFailure(`${what}${detail ? `: ${detail}` : ""}`);
    this.evidence.push(detail ? `${what} (${detail})` : what);
  }

  note(text: string) {
    this.evidence.push(text);
  }

  async sleep(ms: number) {
    if (this.signal.aborted) throw new JourneyFailure(String(this.signal.reason));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      this.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new JourneyFailure(String(this.signal.reason)));
        },
        { once: true },
      );
    });
  }
}

type Res<T = unknown> = { status: number; json: T; text: string };

async function call<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Res<T>> {
  const headers: Record<string, string> = { authorization: `Bearer ${await session.token()}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const timeout = AbortSignal.timeout(60_000);
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${base}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const text = await response.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      // A GET that meets a transient server error is safe to repeat; the retry is logged.
      if (method === "GET" && response.status >= 500 && attempt < 3) {
        console.log(`  [http] ${method} ${path} returned ${response.status}; retrying`);
        continue;
      }
      return { status: response.status, json: json as T, text };
    } catch (error) {
      if (signal?.aborted) throw new JourneyFailure(String(signal.reason));
      if (method === "GET" && attempt < 3) continue;
      return { status: 0, json: undefined as T, text: String(error) };
    }
  }
}

/** `data` of a 2xx answer; fails the journey otherwise. */
async function data<T>(ctx: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  const res = await call<{ data: T }>(method, path, body, ctx.signal);
  if (res.status < 200 || res.status > 299 || !res.json || !("data" in res.json)) {
    throw new JourneyFailure(`${method} ${path} returned ${res.status} ${res.text.slice(0, 300)}`);
  }
  return res.json.data;
}

/** A request to a live app host: no credentials, no redirects. */
async function host(url: string): Promise<{ status: number; text: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.timeout(30_000),
      });
      return { status: response.status, text: await response.text() };
    } catch (error) {
      if (attempt >= 3) return { status: 0, text: String(error) };
    }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Product helpers                                                                             */
/* ------------------------------------------------------------------------------------------ */

const stamp = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

/** Change statuses after which nothing more happens on their own. */
const ENDED = new Set(["completed", "failed", "cancelled", "not_selected", "blocked"]);
/** Statuses in which a person must act. */
const WAITING = new Set(["needs_input", "awaiting_approval", "budget_blocked"]);
/** Task statuses after which a Task does no more work. */
const TASK_ENDED = new Set(["completed", "failed", "cancelled"]);

const COUNTER_GOAL =
  "Build a page that shows a counter with + and - buttons; the count persists in storage.";

/** Creates a Project named `e2e-<journey>-<ts>` and waits for its empty repository. */
async function createProject(ctx: Ctx, tag: string, register = true): Promise<string> {
  const ts = stamp();
  const project = await data<{ id: string }>(ctx, "POST", "/v1/projects", {
    name: `e2e-${tag}-${ts}`,
    slug: `e2e-${tag.toLowerCase()}-${ts}`,
  });
  if (register) ctx.projects.push(project.id);
  ctx.log(`project ${project.id}`);
  const deadline = Date.now() + 3 * MINUTE;
  while (Date.now() < deadline) {
    const p = await data<{ canonical: { artifactRef: string } }>(
      ctx,
      "GET",
      `/v1/projects/${project.id}`,
    );
    if (p.canonical.artifactRef !== "unassigned") return project.id;
    await ctx.sleep(5_000);
  }
  throw new JourneyFailure(`project ${project.id} has no repository after 3 minutes`);
}

async function createChange(
  ctx: Ctx,
  projectId: string,
  goal: string,
  options: { budgetUsd?: number; startPlanning?: boolean } = {},
): Promise<ChangeView> {
  const change = await data<ChangeView>(ctx, "POST", `/v1/projects/${projectId}/changes`, {
    goal,
    ...options,
  });
  ctx.log(`change ${change.id} "${goal.slice(0, 50)}"`);
  return change;
}

const getChange = (ctx: Ctx, id: string) => data<ChangeView>(ctx, "GET", `/v1/changes/${id}`);
const getCandidates = (ctx: Ctx, changeId: string) =>
  data<CandidateView[]>(ctx, "GET", `/v1/changes/${changeId}/candidates`);
const getTasks = (ctx: Ctx, changeId: string) =>
  data<TaskView[]>(ctx, "GET", `/v1/changes/${changeId}/tasks`);
const getApp = (ctx: Ctx, projectId: string) =>
  data<AppView>(ctx, "GET", `/v1/projects/${projectId}/app`);
const generationOf = async (ctx: Ctx, projectId: string) =>
  (await data<{ canonical: { generation: number } }>(ctx, "GET", `/v1/projects/${projectId}`))
    .canonical.generation;

/** Polls a Change until `done` holds. Logs each new status. */
async function waitChange(
  ctx: Ctx,
  id: string,
  done: (c: ChangeView) => boolean,
  label: string,
): Promise<ChangeView> {
  let last = "";
  let signature = "";
  let progressAt = Date.now();
  for (let poll = 0; ; poll++) {
    const change = await getChange(ctx, id);
    if (change.status !== last) {
      ctx.log(`${id.slice(0, 12)} ${change.status}`);
      last = change.status;
    }
    if (done(change)) return change;
    // Progress: the status, a Task run, or a Candidate moved. Read every third poll.
    if (poll % 3 === 0) {
      const [tasks, candidates] = await Promise.all([getTasks(ctx, id), getCandidates(ctx, id)]);
      const next = JSON.stringify([
        change.status,
        change.updatedAt,
        tasks.map((t) => [t.status, t.runs.length, t.runs.at(-1)?.status]),
        candidates.map((c) => [c.id, c.status, c.release?.status]),
      ]);
      if (next !== signature) {
        signature = next;
        progressAt = Date.now();
      } else if (Date.now() - progressAt > NO_PROGRESS_MS) {
        throw new JourneyFailure(
          `no progress for ${NO_PROGRESS_MS / MINUTE} min while waiting for ${label}: ${await explain(ctx, change)}`,
        );
      }
    }
    await ctx.sleep(POLL_MS);
    ctx.step = `waiting for ${label} (${id} is ${change.status})`;
  }
}

/** Waits until the Change has ended or waits for a person. */
const settle = (ctx: Ctx, id: string) =>
  waitChange(ctx, id, (c) => ENDED.has(c.status) || WAITING.has(c.status), "the change to settle");

/** Waits until the intake gate and planning are past: any status but created and compiling. */
const pastIntake = (ctx: Ctx, id: string) =>
  waitChange(ctx, id, (c) => c.status !== "created" && c.status !== "compiling", "intake");

/** Candidates, reasons, and blocked reason of a Change, for a failure message. */
async function explain(ctx: Ctx, change: ChangeView): Promise<string> {
  const candidates = await getCandidates(ctx, change.id).catch(() => [] as CandidateView[]);
  const parts = [
    `status ${change.status}`,
    change.blockedReason ? `blocked: ${change.blockedReason}` : "",
    change.outcome ? `outcome ${change.outcome.kind}: ${change.outcome.reason ?? ""}` : "",
    ...candidates.map(
      (c) => `${c.id} ${c.status}${c.statusReason ? `: ${c.statusReason.slice(0, 200)}` : ""}`,
    ),
  ];
  return parts.filter(Boolean).join("; ");
}

type Shipped = {
  change: ChangeView;
  candidate: CandidateView;
  /** The journey approved and promoted, or promoted, instead of auto-promotion. */
  manual: "none" | "promote" | "approve_and_promote";
};

/**
 * Waits until the Change ships. A Candidate that waits for a person is approved and promoted only
 * when `manual` allows it (the code edit and rollback paths); otherwise the journey fails.
 */
async function ship(ctx: Ctx, changeId: string, manual: boolean): Promise<Shipped> {
  let change = await settle(ctx, changeId);
  let how: Shipped["manual"] = "none";
  if (change.status === "awaiting_approval" && manual) {
    const verified = (await getCandidates(ctx, changeId)).find((c) => c.status === "verified");
    if (!verified) throw new JourneyFailure(`awaiting_approval without a verified Candidate`);
    if (verified.approvalRequired) {
      await data(ctx, "POST", `/v1/changes/${changeId}/approve`, {
        candidateId: verified.id,
        decision: "approve",
        reason: "journeys: approve",
      });
      how = "approve_and_promote";
    } else {
      how = "promote";
    }
    await data(ctx, "POST", `/v1/candidates/${verified.id}/promote`);
    ctx.log(`${how} ${verified.id}`);
    change = await settle(ctx, changeId);
  }
  if (change.status !== "completed") {
    throw new JourneyFailure(`change ${changeId} did not ship: ${await explain(ctx, change)}`);
  }
  const candidate = (await getCandidates(ctx, changeId)).find((c) => c.status === "promoted");
  if (!candidate)
    throw new JourneyFailure(`completed change ${changeId} has no promoted Candidate`);
  return { change, candidate, manual: how };
}

/** Production host checks: the home page, `/api/health`, and the GET routes of `src/app.ts`. */
async function liveAppWorks(ctx: Ctx, projectId: string, generation: number) {
  const app = await getApp(ctx, projectId);
  ctx.check(
    app.app?.status === "ready" && app.app.generation === generation,
    "app pointer ready at the promoted generation",
    `${app.app?.url} ${app.app?.status} S${app.app?.generation}`,
  );
  const url = app.app?.url ?? "";
  const home = await host(`${url}/`);
  ctx.check(
    home.status === 200 && /<html|<!doctype/i.test(home.text),
    "GET / is 200 HTML",
    `${home.status}`,
  );
  const health = await host(`${url}/api/health`);
  ctx.check(health.status === 200, "GET /api/health is 200", `${health.status}`);
  const source = await codeFile(ctx, projectId, "src/app.ts");
  const routes = [
    ...new Set(
      [...(source ?? "").matchAll(/\.get\(\s*["'`](\/api\/[^"'`:*]*)["'`]/g)].map((m) => m[1]),
    ),
  ].filter((r): r is string => typeof r === "string" && r !== "/api/health");
  for (const route of routes.slice(0, 6)) {
    const res = await host(`${url}${route}`);
    ctx.check(res.status >= 200 && res.status < 300, `GET ${route} is 2xx`, `${res.status}`);
  }
  return { url, home: home.text };
}

async function codeTree(ctx: Ctx, projectId: string) {
  return data<{ treeSha: string; files: { path: string }[] }>(
    ctx,
    "GET",
    `/v1/projects/${projectId}/code`,
  );
}

async function codeFile(ctx: Ctx, projectId: string, path: string): Promise<string | null> {
  const res = await call<{ data: { content: string | null } }>(
    "GET",
    `/v1/projects/${projectId}/code?path=${encodeURIComponent(path)}`,
    undefined,
    ctx.signal,
  );
  return res.status === 200 ? (res.json.data.content ?? null) : null;
}

/**
 * A person's code edit through the API: appends an HTML comment with `marker` to the home page.
 * Returns the Change of the edit.
 */
async function editHomePage(ctx: Ctx, projectId: string, marker: string): Promise<string> {
  const tree = await codeTree(ctx, projectId);
  const path =
    tree.files.find((f) => f.path === "public/index.html")?.path ??
    tree.files.find((f) => /^public\/.*\.html$/.test(f.path))?.path;
  if (!path) throw new JourneyFailure("the app has no public HTML page to edit");
  const content = await codeFile(ctx, projectId, path);
  if (content === null) throw new JourneyFailure(`${path} has no stored content`);
  const edited = content.includes("</body>")
    ? content.replace("</body>", `<!-- ${marker} -->\n</body>`)
    : `${content}\n<!-- ${marker} -->\n`;
  const outcome = await data<{ status: string; changeId: string; candidateIds: string[] }>(
    ctx,
    "POST",
    `/v1/projects/${projectId}/code/edits`,
    { path, content: edited, baseTree: tree.treeSha, message: `journeys: ${marker}` },
  );
  ctx.check(outcome.status === "created", "code edit accepted", `${outcome.changeId} ${path}`);
  return outcome.changeId;
}

async function clarify(ctx: Ctx, changeId: string, body: unknown) {
  return data<{ changeStatus: string; action: string; round: number }>(
    ctx,
    "POST",
    `/v1/changes/${changeId}/clarify`,
    body,
  );
}

async function cancel(ctx: Ctx, changeId: string) {
  const res = await call<{ data?: { changeStatus: string } }>(
    "POST",
    `/v1/changes/${changeId}/cancel`,
  );
  ctx.log(`cancel ${changeId.slice(0, 12)}: ${res.status} ${res.json?.data?.changeStatus ?? ""}`);
  return res;
}

async function notifications(ctx: Ctx): Promise<Notification[]> {
  return (await data<{ items: Notification[] }>(ctx, "GET", "/v1/notifications?limit=100")).items;
}

/** Cancels every open Change of a Project, then removes it. Never throws. */
async function removeProject(projectId: string, label: string) {
  try {
    const changes = await call<{ data: { id: string; status: string }[] }>(
      "GET",
      `/v1/projects/${projectId}/changes`,
    );
    for (const c of changes.json?.data ?? []) {
      if (!ENDED.has(c.status)) await call("POST", `/v1/changes/${c.id}/cancel`);
    }
    const res = await call("DELETE", `/v1/projects/${projectId}`);
    console.log(`  [${label}] removed ${projectId}: ${res.status}`);
  } catch (error) {
    console.log(`  [${label}] remove ${projectId} failed: ${String(error)}`);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* The shared counter app (A1, A6, A12, A13, A14, A15, A18)                                    */
/* ------------------------------------------------------------------------------------------ */

type Base = {
  projectId: string;
  changeId: string;
  shipped: Shipped;
  /** Generations promoted on the shared Project, in order, with the marker each one serves. */
  markers: Map<number, string | null>;
};
let baseBuild: Promise<Base> | null = null;
const baseLock = { tail: Promise.resolve() };

/** Builds the counter app once per run; later callers get the same Project. */
function sharedBase(ctx: Ctx): Promise<Base> {
  baseBuild ??= (async () => {
    const projectId = await createProject(ctx, "base", false);
    sharedProjects.push(projectId);
    const change = await createChange(ctx, projectId, COUNTER_GOAL);
    // A held Candidate (an acceptance criterion judged unclear) is approved and promoted here, so
    // the journeys that only need a shipped app still run; A1 checks the auto-promotion itself.
    const shipped = await ship(ctx, change.id, true);
    return {
      projectId,
      changeId: change.id,
      shipped,
      markers: new Map([[shipped.candidate.promotedGeneration ?? 1, null]]),
    };
  })();
  return baseBuild;
}

/** Runs `fn` with the shared Project, one journey at a time. */
async function withBase<T>(ctx: Ctx, fn: (base: Base) => Promise<T>): Promise<T> {
  const previous = baseLock.tail;
  let release = () => {};
  baseLock.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn(await sharedBase(ctx));
  } finally {
    release();
  }
}

const sharedProjects: string[] = [];

/** Ships one code edit on the shared Project and records its marker. */
async function shipEdit(ctx: Ctx, b: Base, marker: string): Promise<Shipped> {
  const changeId = await editHomePage(ctx, b.projectId, marker);
  const shipped = await ship(ctx, changeId, true);
  b.markers.set(shipped.candidate.promotedGeneration ?? -1, marker);
  return shipped;
}

/* ------------------------------------------------------------------------------------------ */
/* Journeys                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** A1: clear request, plan, build, verify, acceptance pass, auto-promotion, live app works. */
async function a1(ctx: Ctx) {
  await withBase(ctx, async (b) => {
    const { change, candidate, manual } = b.shipped;
    ctx.check(manual === "none", "no person promoted", `${change.id}`);
    const tasks = await getTasks(ctx, change.id);
    ctx.check(
      tasks.length > 0 && tasks.every((t) => t.status === "completed"),
      "every Task completed",
      `${tasks.length} Tasks`,
    );
    // The feed keeps an allow-list of payload fields; the actor names the auto-promotion path
    // (`system:auto-promotion`), the same promoteCandidate call a person makes.
    const events = await data<{
      events: { eventType: string; actor: { kind: string; id: string } }[];
    }>(ctx, "GET", `/v1/changes/${change.id}/events?limit=100`);
    const requested = events.events.find((e) => e.eventType === "canonical.promotion.requested");
    ctx.check(
      requested?.actor.kind === "system" && requested.actor.id === "auto-promotion",
      "promotion requested by auto-promotion",
      `actor ${requested?.actor.kind}:${requested?.actor.id}`,
    );
    const acceptance = candidate.acceptance ?? [];
    ctx.check(
      acceptance.length > 0 && acceptance.every((a) => a.status === "met"),
      "every acceptance criterion met",
      `${acceptance.length} criteria`,
    );
    ctx.check(
      candidate.release?.status === "deployed",
      "release deployed",
      `${candidate.release?.id} ${candidate.release?.status}`,
    );
    const generation = candidate.promotedGeneration ?? -1;
    ctx.note(`${candidate.id} promoted S${generation}`);
    const live = await liveAppWorks(ctx, b.projectId, generation);
    ctx.note(live.url);
  });
}

/** A2: an unclear request asks, the answer makes it plan and build. */
async function a2(ctx: Ctx) {
  const projectId = await createProject(ctx, "a2");
  const change = await createChange(ctx, projectId, "make it better");
  let current = await pastIntake(ctx, change.id);
  ctx.check(
    current.status === "needs_input" && current.clarification?.kind === "unclear",
    "needs_input, kind unclear",
    await explain(ctx, current),
  );
  const first = current.clarification;
  ctx.check(
    (first?.questions.length ?? 0) > 0,
    "questions asked",
    `${first?.questions.length} questions, ${first?.questions[0]?.options?.length ?? 0} options`,
  );
  let rounds = 0;
  while (current.status === "needs_input" && current.clarification && rounds < 3) {
    rounds += 1;
    const answers = current.clarification.questions.map((q, i) => ({
      questionId: q.id,
      text:
        i === 0
          ? `${COUNTER_GOAL} Nothing else.`
          : "Choose the simplest option: one page, no accounts, no styling choices.",
    }));
    const recorded = await clarify(ctx, change.id, { answers });
    ctx.log(`answered round ${recorded.round}: ${recorded.changeStatus}`);
    current = await pastIntake(ctx, change.id);
  }
  ctx.check(rounds >= 1, "answered", `${rounds} rounds`);
  const shipped = await ship(ctx, change.id, false);
  const generation = shipped.candidate.promotedGeneration ?? -1;
  ctx.check(generation === 1, "built and promoted", `${shipped.candidate.id} S${generation}`);
  await liveAppWorks(ctx, projectId, generation);
}

/** A3: an unclear request, then "Build it as it is", plans. */
async function a3(ctx: Ctx) {
  const projectId = await createProject(ctx, "a3");
  const change = await createChange(ctx, projectId, "make it better");
  const asked = await pastIntake(ctx, change.id);
  ctx.check(
    asked.status === "needs_input" && asked.clarification?.kind === "unclear",
    "needs_input, kind unclear",
    await explain(ctx, asked),
  );
  const recorded = await clarify(ctx, change.id, { action: "proceed_anyway" });
  ctx.check(
    recorded.action === "proceed_anyway" && recorded.changeStatus === "compiling",
    "proceed_anyway recorded",
    recorded.changeStatus,
  );
  const planned = await pastIntake(ctx, change.id);
  ctx.check(planned.status === "running", "planned and running", await explain(ctx, planned));
  const tasks = await getTasks(ctx, change.id);
  ctx.check(tasks.length > 0, "Work Graph stored", `${tasks.length} Tasks`);
  await cancel(ctx, change.id);
}

/** A4: an unclear request, then withdraw: cancelled, no Tasks, no spend after intake. */
async function a4(ctx: Ctx) {
  const projectId = await createProject(ctx, "a4");
  const change = await createChange(ctx, projectId, "make it better");
  const asked = await pastIntake(ctx, change.id);
  ctx.check(
    asked.status === "needs_input" && asked.clarification?.kind === "unclear",
    "needs_input, kind unclear",
    await explain(ctx, asked),
  );
  const recorded = await clarify(ctx, change.id, { action: "withdraw" });
  ctx.check(recorded.changeStatus === "cancelled", "withdraw cancels", recorded.changeStatus);
  await ctx.sleep(20_000);
  const after = await getChange(ctx, change.id);
  ctx.check(after.status === "cancelled", "still cancelled after 20 s", after.status);
  const tasks = await getTasks(ctx, change.id);
  ctx.check(tasks.length === 0, "no Tasks", `${tasks.length}`);
  const cost = await data<{ changes: { id: string; runs: number; costUsd: number }[] }>(
    ctx,
    "GET",
    `/v1/projects/${projectId}/cost?changeId=${change.id}`,
  );
  const row = cost.changes.find((c) => c.id === change.id);
  ctx.check(row?.runs === 0, "no agent runs or agent spend", `runs ${row?.runs} $${row?.costUsd}`);
}

/** A5: a duplicate of an open request asks; withdraw; asked again, an answer makes it plan. */
async function a5(ctx: Ctx) {
  const projectId = await createProject(ctx, "a5");
  // The open request: stored, not planned (no spend). Retrieval reads every open Change.
  const open = await createChange(ctx, projectId, COUNTER_GOAL, { startPlanning: false });
  const dup = await createChange(ctx, projectId, COUNTER_GOAL);
  const asked = await pastIntake(ctx, dup.id);
  ctx.check(
    asked.status === "needs_input" && asked.clarification?.kind === "duplicate",
    "needs_input, kind duplicate",
    await explain(ctx, asked),
  );
  ctx.check(
    asked.clarification?.relatedChangeId === open.id,
    "names the open request",
    `${asked.clarification?.relatedChangeId}`,
  );
  const question = asked.clarification?.questions[0]?.text ?? "";
  ctx.check(question.includes('"'), "question quotes the covering text", question.slice(0, 160));
  const withdrawn = await clarify(ctx, dup.id, { action: "withdraw" });
  ctx.check(withdrawn.changeStatus === "cancelled", "withdraw cancels", withdrawn.changeStatus);
  const closed = await getChange(ctx, dup.id);
  ctx.check(
    closed.outcome?.kind === "duplicate" && closed.outcome.winnerChangeId === open.id,
    "outcome duplicate of the open request",
    `${closed.outcome?.kind} ${closed.outcome?.winnerChangeId}`,
  );

  const again = await createChange(ctx, projectId, COUNTER_GOAL);
  const askedAgain = await pastIntake(ctx, again.id);
  ctx.check(
    askedAgain.status === "needs_input" && askedAgain.clarification?.kind === "duplicate",
    "asked again: needs_input, kind duplicate",
    await explain(ctx, askedAgain),
  );
  const q = askedAgain.clarification?.questions[0]?.id ?? "q1";
  await clarify(ctx, again.id, {
    answers: [
      {
        questionId: q,
        text: "It is different because this counter also has a Reset button that sets the count back to zero.",
      },
    ],
  });
  const planned = await pastIntake(ctx, again.id);
  ctx.check(planned.status === "running", "the answer makes it plan", await explain(ctx, planned));
  await cancel(ctx, again.id);
  await cancel(ctx, open.id);
}

/** A6: the same feature again after it shipped asks as a duplicate of the app. */
async function a6(ctx: Ctx) {
  await withBase(ctx, async (b) => {
    const change = await createChange(ctx, b.projectId, COUNTER_GOAL);
    const asked = await pastIntake(ctx, change.id);
    if (asked.status === "running") await cancel(ctx, change.id);
    ctx.check(
      asked.status === "needs_input" && asked.clarification?.kind === "duplicate",
      "needs_input, kind duplicate",
      await explain(ctx, asked),
    );
    const related = asked.clarification?.relatedChangeId ?? null;
    ctx.check(
      related === null || related === b.changeId,
      "duplicate of the current app or its shipped request",
      related ?? "the current app",
    );
    ctx.note(`question: ${asked.clarification?.questions[0]?.text.slice(0, 160)}`);
    const withdrawn = await clarify(ctx, change.id, { action: "withdraw" });
    ctx.check(withdrawn.changeStatus === "cancelled", "withdraw cancels", withdrawn.changeStatus);
  });
}

/** A7: two independent requests at once both plan and ship in sequence, without merge failure. */
async function a7(ctx: Ctx) {
  const projectId = await createProject(ctx, "a7");
  const first = await createChange(ctx, projectId, COUNTER_GOAL);
  await ship(ctx, first.id, false);
  const footer = "Made with Rhumbatron";
  const title = "Counter Deluxe";
  const [a, b] = await Promise.all([
    createChange(ctx, projectId, `Add a footer to the home page with the text "${footer}".`),
    createChange(
      ctx,
      projectId,
      `Change the home page title (the browser tab title and the main heading) to "${title}".`,
    ),
  ]);
  const [shippedA, shippedB] = await Promise.all([ship(ctx, a.id, false), ship(ctx, b.id, false)]);
  const ordered = [shippedA, shippedB].sort(
    (x, y) => (x.candidate.promotedGeneration ?? 0) - (y.candidate.promotedGeneration ?? 0),
  );
  const [earlier, later] = ordered as [Shipped, Shipped];
  ctx.check(
    earlier.candidate.promotedGeneration === 2 && later.candidate.promotedGeneration === 3,
    "both shipped in sequence",
    `S${earlier.candidate.promotedGeneration} ${earlier.change.id}, S${later.candidate.promotedGeneration} ${later.change.id}`,
  );
  ctx.check(
    later.candidate.baseGeneration === 2,
    "the second rebased onto the first's generation",
    `${later.candidate.id} base S${later.candidate.baseGeneration}`,
  );
  for (const s of ordered) {
    // Both requests edit the home page. When git cannot merge the stale Candidate on the new
    // base, the designed path re-runs the Task on the current files (rebase.ts); the Change must
    // then ship on the newer base, never end blocked.
    const all = await getCandidates(ctx, s.change.id);
    const merge = all.filter((c) => /conflict|merge/i.test(c.statusReason ?? ""));
    const resolved = merge.every((m) => s.candidate.baseGeneration > m.baseGeneration);
    ctx.check(
      resolved,
      `no unresolved merge failure in ${s.change.id.slice(0, 12)}`,
      merge.length === 0
        ? `${all.length} Candidates`
        : `rebased after ${merge.map((c) => `${c.id} S${c.baseGeneration}: ${c.statusReason?.slice(0, 80)}`).join("; ")}; shipped from S${s.candidate.baseGeneration}`,
    );
    ctx.check(
      !s.change.outcome || ["selected", "replaces"].includes(s.change.outcome.kind),
      `outcome of ${s.change.id.slice(0, 12)}`,
      `${s.change.outcome?.kind ?? "none"}`,
    );
  }
  const live = await liveAppWorks(ctx, projectId, 3);
  ctx.check(live.home.includes(footer), "live app has the footer");
  ctx.check(live.home.includes(title), "live app has the new title");
}

/** A8: the same person asks for two conflicting things at once. */
async function a8(ctx: Ctx) {
  const projectId = await createProject(ctx, "a8");
  const [navy, yellow] = await Promise.all([
    createChange(ctx, projectId, "Build a single page that says Hello on a dark navy background."),
    createChange(
      ctx,
      projectId,
      "Build a single page that says Hello on a light yellow background.",
    ),
  ]);
  // Wait until both are past intake and the cross-request check decided something.
  const decided = async () => {
    for (;;) {
      const both = await Promise.all([getChange(ctx, navy.id), getChange(ctx, yellow.id)]);
      const settled = both.every((c) => c.status !== "created" && c.status !== "compiling");
      const conflicts = await data<unknown[]>(
        ctx,
        "GET",
        `/v1/changes/${both[1].id}/request-conflicts`,
      );
      if (settled) return { both, conflicts };
      await ctx.sleep(POLL_MS);
      ctx.step = `waiting for both requests (${both.map((c) => c.status).join(", ")}, ${conflicts.length} conflicts)`;
    }
  };
  const { both, conflicts } = await decided();
  for (const c of both) {
    ctx.note(
      `${c.id.slice(0, 12)} ${c.status} ${c.outcome?.kind ?? "-"} ${c.outcome?.decidedBy ?? ""}: ${(c.outcome?.reason ?? c.clarification?.summary ?? "").slice(0, 160)}`,
    );
  }
  ctx.note(`request-conflicts rows: ${JSON.stringify(conflicts).slice(0, 400)}`);
  const loser = both.find((c) => c.status === "cancelled" || c.status === "not_selected");
  const asking = both.find(
    (c) =>
      c.status === "needs_input" &&
      ["conflict", "duplicate", "unclear"].includes(c.clarification?.kind ?? ""),
  );
  if (loser) {
    const winner = both.find((c) => c.id !== loser.id);
    ctx.check(
      loser.outcome?.kind === "not_selected" && loser.outcome.winnerChangeId === winner?.id,
      "the earlier request lost to the later one",
      `${loser.outcome?.kind} winner ${loser.outcome?.winnerChangeId}`,
    );
    ctx.check(
      loser.outcome?.decidedBy === "system:same_requester",
      "decided by the system: the same requester's later request replaces the earlier one",
      `${loser.outcome?.decidedBy}`,
    );
    ctx.check(
      (loser.outcome?.reason ?? "").length > 0,
      "the reason names the winner",
      loser.outcome?.reason?.slice(0, 160) ?? "",
    );
    ctx.check(
      ["selected", "replaces"].includes(winner?.outcome?.kind ?? ""),
      "winner outcome",
      `${winner?.outcome?.kind}`,
    );
  } else if (asking) {
    ctx.check(
      asking.clarification?.relatedChangeId !== null,
      "the later request asks its requester and names the other request",
      `${asking.clarification?.kind} ${asking.clarification?.relatedChangeId}`,
    );
  } else {
    throw new JourneyFailure(
      `both conflicting requests went on without a decision: ${both.map((c) => `${c.id} ${c.status} ${c.outcome?.kind ?? "-"}`).join("; ")}`,
    );
  }
  for (const c of both) if (!ENDED.has(c.status)) await cancel(ctx, c.id);
}

/** A9: cancel a running Change: Tasks cancelled, Candidates rejected, no release. */
async function a9(ctx: Ctx) {
  const projectId = await createProject(ctx, "a9");
  const change = await createChange(
    ctx,
    projectId,
    "Build a recipe box: a list of recipes, a form to add a recipe with a title and ingredients, a page for one recipe, and a delete button. Recipes persist in storage.",
  );
  await waitChange(
    ctx,
    change.id,
    (c) => c.status === "running" || ENDED.has(c.status) || WAITING.has(c.status),
    "running",
  );
  for (;;) {
    const tasks = await getTasks(ctx, change.id);
    if (tasks.some((t) => t.status === "running" || t.status === "assigned")) break;
    const c = await getChange(ctx, change.id);
    if (c.status !== "running") throw new JourneyFailure(`left running first: ${c.status}`);
    await ctx.sleep(5_000);
  }
  const res = await cancel(ctx, change.id);
  ctx.check(
    res.status === 200 &&
      (res.json as { data?: { changeStatus?: string } }).data?.changeStatus === "cancelled",
    "cancel recorded",
    `${res.status}`,
  );
  const deadline = Date.now() + 3 * MINUTE;
  let tasks = await getTasks(ctx, change.id);
  while (Date.now() < deadline && !tasks.every((t) => TASK_ENDED.has(t.status))) {
    await ctx.sleep(POLL_MS);
    tasks = await getTasks(ctx, change.id);
  }
  ctx.check(
    tasks.every((t) => TASK_ENDED.has(t.status)) && tasks.some((t) => t.status === "cancelled"),
    "open Tasks cancelled",
    tasks.map((t) => `${t.key} ${t.status}`).join(", "),
  );
  await ctx.sleep(30_000);
  const after = await getChange(ctx, change.id);
  ctx.check(after.status === "cancelled", "the Change stays cancelled", after.status);
  const candidates = await getCandidates(ctx, change.id);
  ctx.check(
    candidates.every((c) => c.status === "rejected" || c.status === "stale"),
    "Candidates rejected",
    candidates.map((c) => `${c.id} ${c.status}`).join(", ") || "none",
  );
  const { releases } = await data<{ releases: ReleaseView[] }>(
    ctx,
    "GET",
    `/v1/projects/${projectId}/releases`,
  );
  ctx.check(releases.length === 0, "no release", `${releases.length}`);
  ctx.check((await generationOf(ctx, projectId)) === 0, "canonical stays S0");
}

/** A10: a small budget stops work; raising it continues. */
async function a10(ctx: Ctx) {
  const projectId = await createProject(ctx, "a10");
  // A tiny build spends about $0.10 on agent runs, and a large request planned into a few Tasks
  // still finished under $0.50 on prod. A $0.05 budget is below one Sonnet run, so the stop is
  // certain and cheap.
  const change = await createChange(ctx, projectId, COUNTER_GOAL, { budgetUsd: 0.05 });
  const blocked = await settle(ctx, change.id);
  ctx.check(blocked.status === "budget_blocked", "budget_blocked", await explain(ctx, blocked));
  ctx.note(`reason: ${blocked.blockedReason}`);
  const raisedAt = new Date().toISOString();
  const raised = await data<{
    changeStatus: string;
    budgetUsd: number;
    dispatchedTaskIds: string[];
  }>(ctx, "POST", `/v1/changes/${change.id}/budget`, { budgetUsd: 3 });
  // A stop while planning resumes in `compiling` (planning runs again); a stop while building
  // resumes in `running` (ADR 0030).
  ctx.check(
    ["running", "compiling"].includes(raised.changeStatus) && raised.budgetUsd === 3,
    "raise resumes the Change",
    `${raised.changeStatus} $${raised.budgetUsd}, ${raised.dispatchedTaskIds.length} Tasks dispatched`,
  );
  // Work continues: a run starts after the raise.
  const waitFrom = Date.now();
  for (;;) {
    if (Date.now() - waitFrom > NO_PROGRESS_MS) {
      throw new JourneyFailure(
        `no Task run in ${NO_PROGRESS_MS / MINUTE} min after the raise: ${await explain(ctx, await getChange(ctx, change.id))}`,
      );
    }
    const tasks = await getTasks(ctx, change.id);
    const resumed = tasks.find((t) => t.runs.some((r) => r.startedAt > raisedAt));
    if (resumed) {
      ctx.note(`${resumed.key} ran again after the raise (${resumed.status})`);
      break;
    }
    const c = await getChange(ctx, change.id);
    if (ENDED.has(c.status)) throw new JourneyFailure(`no run after the raise: ${c.status}`);
    await ctx.sleep(POLL_MS);
  }
  await cancel(ctx, change.id);
}

const AUTH_GOAL =
  "Build a notes page: anyone can add a note, but only the admin can delete a note. Use a demo user picker (alice is the admin, bob is not); the delete API answers 403 for bob.";

/** A11: an authorization request waits for approval; approve promotes, reject rejects. */
async function a11(ctx: Ctx) {
  const run = async (decision: "approve" | "reject"): Promise<string> => {
    const projectId = await createProject(ctx, `a11${decision[0]}`);
    const change = await createChange(ctx, projectId, AUTH_GOAL);
    let waiting = await settle(ctx, change.id);
    // The intake gate may ask which reading is meant; the person builds it as stated.
    if (waiting.status === "needs_input" && waiting.clarification?.kind === "unclear") {
      ctx.note(`${decision} run asked: ${waiting.clarification.summary}; proceed_anyway`);
      await clarify(ctx, change.id, { action: "proceed_anyway" });
      waiting = await settle(ctx, change.id);
    }
    ctx.check(
      waiting.status === "awaiting_approval",
      `${decision} run: awaiting_approval`,
      `${waiting.riskTier} risk; ${await explain(ctx, waiting)}`,
    );
    const candidate = (await getCandidates(ctx, change.id)).find((c) => c.status === "verified");
    ctx.check(
      candidate?.approvalRequired === true,
      `${decision} run: verified Candidate requires approval`,
      `${candidate?.id}`,
    );
    const candidateId = candidate?.id ?? "";
    const inbox = await notifications(ctx);
    ctx.check(
      inbox.some((n) => n.kind === "approval_required" && n.candidateId === candidateId),
      `${decision} run: approval_required notification`,
    );
    const decided = await data<{ status: string; approval: { decision: string } }>(
      ctx,
      "POST",
      `/v1/changes/${change.id}/approve`,
      { candidateId, decision, reason: `journeys: ${decision}` },
    );
    ctx.check(
      decided.status === "recorded",
      `${decision} recorded`,
      `${decided.approval.decision}`,
    );
    if (decision === "approve") {
      const promoted = await data<{ status: string; generation: number }>(
        ctx,
        "POST",
        `/v1/candidates/${candidateId}/promote`,
      );
      ctx.check(promoted.status === "promoted", "promoted", `S${promoted.generation}`);
      const shipped = await ship(ctx, change.id, false);
      ctx.check(
        shipped.candidate.release?.status === "deployed",
        "approved release deployed",
        `${shipped.candidate.release?.id}`,
      );
    } else {
      const after = (await getCandidates(ctx, change.id)).find((c) => c.id === candidateId);
      ctx.check(
        after?.status === "rejected",
        "rejected Candidate",
        `${after?.status}: ${after?.statusReason}`,
      );
      ctx.check((await generationOf(ctx, projectId)) === 0, "reject: canonical stays S0");
      const c = await getChange(ctx, change.id);
      ctx.note(`reject run change status ${c.status}`);
      if (!ENDED.has(c.status)) await cancel(ctx, change.id);
    }
    return projectId;
  };
  // One after the other, and the approved app removed in between: each live app keeps ready
  // bundles, and the Dynamic Worker meter counts every ready bundle.
  const approved = await run("approve");
  await removeProject(approved, ctx.id);
  await run("reject");
}

/** A12: roll back to an earlier generation: a new generation with the old tree, served live. */
async function a12(ctx: Ctx) {
  await withBase(ctx, async (b) => {
    let current = await generationOf(ctx, b.projectId);
    if (current < 2) {
      await shipEdit(ctx, b, `journeys-a12-${stamp()}`);
      current = await generationOf(ctx, b.projectId);
    }
    // Roll back to the newest generation whose home page differs from the live one.
    const liveMarker = b.markers.get(current) ?? null;
    const target = [...b.markers.entries()]
      .filter(([g, m]) => g < current && m !== liveMarker)
      .sort((x, y) => y[0] - x[0])[0];
    if (!target) throw new JourneyFailure(`no earlier generation with other content (S${current})`);
    const [targetGeneration, targetMarker] = target;
    const res = await call<{ data: { status: string; changeId: string; candidateId: string } }>(
      "POST",
      `/v1/projects/${b.projectId}/rollback`,
      { targetGeneration, expectedGeneration: current },
      ctx.signal,
    );
    ctx.check(
      res.status === 200 || res.status === 202,
      "rollback accepted",
      `${res.status} ${res.json?.data?.status} S${current} -> tree of S${targetGeneration}`,
    );
    const { changeId } = res.json.data;
    const shipped = await ship(ctx, changeId, true);
    const generation = shipped.candidate.promotedGeneration ?? -1;
    ctx.check(
      generation === current + 1,
      "a new generation",
      `S${generation} via ${shipped.manual}`,
    );
    const versions = await data<{ versions: { generation: number; treeSha: string | null }[] }>(
      ctx,
      "GET",
      `/v1/projects/${b.projectId}/versions`,
    );
    const tree = (g: number) => versions.versions.find((v) => v.generation === g)?.treeSha;
    ctx.check(
      !!tree(generation) && tree(generation) === tree(targetGeneration),
      "the new tree equals the old tree",
      `${tree(generation)?.slice(0, 12)}`,
    );
    b.markers.set(generation, targetMarker ?? null);
    const live = await liveAppWorks(ctx, b.projectId, generation);
    ctx.check(
      targetMarker
        ? live.home.includes(targetMarker)
        : !liveMarker || !live.home.includes(liveMarker),
      "the live app serves the old version",
      `marker ${targetMarker ?? "none"} instead of ${liveMarker ?? "none"}`,
    );
  });
}

/** A13: remove the app: every host answers 410; publishing again makes it live. */
async function a13(ctx: Ctx) {
  await withBase(ctx, async (b) => {
    const before = await getApp(ctx, b.projectId);
    const hosts = [before.app?.url ?? "", ...before.versions.map((v) => v.url)].filter(Boolean);
    const removed = await call<{ data: { status: string } }>(
      "DELETE",
      `/v1/projects/${b.projectId}/app`,
      undefined,
      ctx.signal,
    );
    ctx.check(removed.status === 202, "remove app accepted", `${removed.json?.data?.status}`);
    // The router caches pointer rows for 10 s in each isolate, so a host may serve the old row
    // for up to 10 s after the removal.
    const removedAt = Date.now();
    for (const url of hosts) {
      let res = await host(`${url}/`);
      while (res.status !== 410 && Date.now() - removedAt < 30_000) {
        await ctx.sleep(3_000);
        res = await host(`${url}/`);
      }
      ctx.check(
        res.status === 410,
        `${new URL(url).hostname} answers 410`,
        `${res.status} after ${Math.round((Date.now() - removedAt) / 1000)} s`,
      );
    }
    // Publishing revives a removed app once its cleanup finished (the tombstone has no commit).
    const deadline = Date.now() + 10 * MINUTE;
    for (;;) {
      const app = await getApp(ctx, b.projectId);
      if (app.app?.status === "removed" && app.app.commit === null) break;
      if (Date.now() > deadline) throw new JourneyFailure("app cleanup did not finish in 10 min");
      await ctx.sleep(POLL_MS);
    }
    const published = await call<{ data: { status: string } }>(
      "POST",
      `/v1/projects/${b.projectId}/app`,
      undefined,
      ctx.signal,
    );
    ctx.check(published.status === 202, "publish again queued", `${published.json?.data?.status}`);
    const generation = await generationOf(ctx, b.projectId);
    for (;;) {
      const app = await getApp(ctx, b.projectId);
      if (app.app?.status === "ready" && app.app.generation === generation) break;
      if (app.app?.status === "failed") {
        throw new JourneyFailure(`publish failed: ${app.app.failureReason}`);
      }
      if (Date.now() > deadline) throw new JourneyFailure(`app not ready: ${app.app?.status}`);
      await ctx.sleep(POLL_MS);
    }
    await liveAppWorks(ctx, b.projectId, generation);
  });
}

/** A14: a person's code edit through the API runs the same checks and ships. */
async function a14(ctx: Ctx) {
  await withBase(ctx, async (b) => {
    const before = await generationOf(ctx, b.projectId);
    const marker = `journeys-a14-${stamp()}`;
    const shipped = await shipEdit(ctx, b, marker);
    const generation = shipped.candidate.promotedGeneration ?? -1;
    ctx.check(generation === before + 1, "edit promoted", `S${generation} via ${shipped.manual}`);
    const checks = shipped.candidate.plan?.checks ?? [];
    const required = checks.filter((c) => c.required).map((c) => c.checkId);
    ctx.check(
      ["build", "unit", "contract", "preview-smoke"].every((id) => required.includes(id)),
      "the same required checks as agent work",
      required.join(", "),
    );
    const evidence = await data<{ checkId: string; status: string; coverage: string }[]>(
      ctx,
      "GET",
      `/v1/candidates/${shipped.candidate.id}/evidence`,
    );
    const passed = required.every((id) =>
      evidence.some(
        (e) => e.checkId === id && e.status === "pass" && e.coverage === "checked_supported",
      ),
    );
    ctx.check(passed, "every required check passed with evidence", `${evidence.length} records`);
    const live = await liveAppWorks(ctx, b.projectId, generation);
    ctx.check(live.home.includes(marker), "the live app serves the edit", marker);
  });
}

/** A15: an injected release failure keeps the pointer; the next promotion recovers. */
async function a15(ctx: Ctx) {
  await withBase(ctx, async (b) => {
    const before = await getApp(ctx, b.projectId);
    const injected = await data<{ status: string; release: ReleaseView; repeated: boolean }>(
      ctx,
      "POST",
      `/v1/projects/${b.projectId}/releases/inject-failure`,
    );
    ctx.check(
      injected.status === "recorded" && injected.release.status === "smoke_failed",
      "release smoke_failed",
      `${injected.release.id}: ${injected.release.failureReason?.slice(0, 120)}`,
    );
    const after = await getApp(ctx, b.projectId);
    ctx.check(
      after.app?.commit === before.app?.commit && after.app?.status === "ready",
      "the pointer stays on the deployed version",
      `${after.app?.commit?.slice(0, 12)} ${after.app?.status}`,
    );
    const home = await host(`${after.app?.url}/`);
    ctx.check(home.status === 200, "the live app still answers", `${home.status}`);
    const marker = `journeys-a15-${stamp()}`;
    const shipped = await shipEdit(ctx, b, marker);
    const generation = shipped.candidate.promotedGeneration ?? -1;
    ctx.check(
      shipped.candidate.release?.status === "deployed",
      "the next promotion deploys",
      `${shipped.candidate.release?.id} S${generation}`,
    );
    const live = await liveAppWorks(ctx, b.projectId, generation);
    ctx.check(live.home.includes(marker), "the live app serves the recovery");
  });
}

/** A16: settings: rename, default budget; a Change without a budget gets the default. */
async function a16(ctx: Ctx) {
  const projectId = await createProject(ctx, "a16");
  const name = `e2e-A16-renamed-${stamp()}`;
  const patched = await data<{ name: string; defaultBudgetUsd: number | null }>(
    ctx,
    "PATCH",
    `/v1/projects/${projectId}`,
    { name, defaultBudgetUsd: 1.25 },
  );
  ctx.check(
    patched.name === name && patched.defaultBudgetUsd === 1.25,
    "PATCH name and default budget",
  );
  const settings = await data<{
    name: string;
    defaultBudgetUsd: number | null;
    effectiveDefaultBudgetUsd: number;
  }>(ctx, "GET", `/v1/projects/${projectId}/settings`);
  ctx.check(
    settings.name === name && settings.effectiveDefaultBudgetUsd === 1.25,
    "settings read back",
    `${settings.name} $${settings.effectiveDefaultBudgetUsd}`,
  );
  const project = await data<{ name: string }>(ctx, "GET", `/v1/projects/${projectId}`);
  ctx.check(project.name === name, "project name changed");
  const bad = await call("PATCH", `/v1/projects/${projectId}`, { defaultBudgetUsd: 0.1 });
  ctx.check(bad.status === 400, "a default below the minimum is 400", `${bad.status}`);
  const without = await createChange(ctx, projectId, "Add an about page.", {
    startPlanning: false,
  });
  ctx.check(
    without.budgetUsd === 1.25,
    "a Change without a budget uses the default",
    `$${without.budgetUsd}`,
  );
  const own = await createChange(ctx, projectId, "Add a contact page.", {
    startPlanning: false,
    budgetUsd: 2,
  });
  ctx.check(own.budgetUsd === 2, "a Change with a budget keeps it", `$${own.budgetUsd}`);
  const reset = await data<{ defaultBudgetUsd: number | null; effectiveDefaultBudgetUsd: number }>(
    ctx,
    "PATCH",
    `/v1/projects/${projectId}`,
    { defaultBudgetUsd: null },
  );
  ctx.check(
    reset.defaultBudgetUsd === null && reset.effectiveDefaultBudgetUsd === 3,
    "null returns to the built-in default",
  );
  const builtIn = await createChange(ctx, projectId, "Add a help page.", { startPlanning: false });
  ctx.check(builtIn.budgetUsd === 3, "then a Change gets $3", `$${builtIn.budgetUsd}`);
  for (const c of [without, own, builtIn]) await cancel(ctx, c.id);
}

/** A17: delete a Project: archived, cleaned up, rows gone, the app host answers 410. */
async function a17(ctx: Ctx) {
  const projectId = await createProject(ctx, "a17");
  const change = await createChange(ctx, projectId, "Add an about page.", { startPlanning: false });
  let app = await getApp(ctx, projectId);
  for (let i = 0; i < 18 && !app.app; i++) {
    await ctx.sleep(POLL_MS);
    app = await getApp(ctx, projectId);
  }
  const url = app.app?.url ?? "";
  ctx.check(!!url, "the empty Project has an app host", url);
  const before = await host(`${url}/`);
  ctx.check(before.status === 200, "the host answers before delete", `${before.status}`);
  const deleted = await data<{ status: string; cleanupQueued: boolean }>(
    ctx,
    "DELETE",
    `/v1/projects/${projectId}`,
  );
  ctx.check(deleted.status === "archived", "archived", `cleanupQueued ${deleted.cleanupQueued}`);
  const listed = await data<{ id: string }[]>(ctx, "GET", "/v1/projects?limit=200");
  ctx.check(!listed.some((p) => p.id === projectId), "left the Projects list");
  const archived = await data<{ id: string; status: string }[]>(
    ctx,
    "GET",
    "/v1/projects?limit=200&include=archived",
  );
  ctx.check(
    archived.find((p) => p.id === projectId)?.status === "archived",
    "listed as archived with include=archived",
  );
  const snapshot = await call("GET", `/v1/projects/${projectId}/snapshot`);
  ctx.check(
    snapshot.status === 409,
    "snapshot of an archived Project is 409",
    `${snapshot.status}`,
  );
  const refused = await call("POST", `/v1/projects/${projectId}/changes`, { goal: "Add a page." });
  ctx.check(refused.status === 409, "no new Change on an archived Project", `${refused.status}`);
  // The cleanup command marks the app removed when it starts; the router caches its pointer
  // for 10 s. So the host answers 410 within seconds of the delete, not in the same request.
  const deletedAt = Date.now();
  let gone = await host(`${url}/`);
  while (gone.status !== 410 && Date.now() - deletedAt < 2 * MINUTE) {
    await ctx.sleep(5_000);
    gone = await host(`${url}/`);
  }
  ctx.check(
    gone.status === 410,
    "the app host answers 410",
    `${gone.status} after ${Math.round((Date.now() - deletedAt) / 1000)} s`,
  );
  const deadline = Date.now() + 10 * MINUTE;
  let cleanedAt: string | null = null;
  while (!cleanedAt) {
    if (Date.now() > deadline) throw new JourneyFailure("cleanup did not finish in 10 min");
    await ctx.sleep(20_000);
    // A repeat is idempotent and answers the cleanup time once it is done.
    const again = await data<{ cleanedAt: string | null }>(
      ctx,
      "DELETE",
      `/v1/projects/${projectId}`,
    );
    cleanedAt = again.cleanedAt;
  }
  ctx.note(`cleaned at ${cleanedAt}`);
  const row = await call("GET", `/v1/changes/${change.id}`);
  ctx.check(row.status === 404, "the Change rows are deleted", `${row.status}`);
  const code = await call("GET", `/v1/projects/${projectId}/code`);
  ctx.check(code.status !== 200, "no source is readable", `${code.status}`);
  const after = await host(`${url}/`);
  ctx.check(
    after.status === 410,
    "the app host still answers 410 after cleanup",
    `${after.status}`,
  );
}

/** A18: needs_input and release notifications reach the requester; marking read works. */
async function a18(ctx: Ctx) {
  await withBase(ctx, async (b) => {
    const projectId = await createProject(ctx, "a18");
    const change = await createChange(ctx, projectId, "make it better");
    const asked = await pastIntake(ctx, change.id);
    ctx.check(asked.status === "needs_input", "needs_input", await explain(ctx, asked));
    let inbox = await notifications(ctx);
    const needs = inbox.find((n) => n.kind === "request_needs_input" && n.changeId === change.id);
    ctx.check(!!needs, "request_needs_input notification", needs?.id ?? "");
    const deployed = inbox.find(
      (n) => n.kind === "release_deployed" && n.projectId === b.projectId,
    );
    ctx.check(!!deployed, "release_deployed notification", deployed?.id ?? "");
    const ids = [needs?.id, deployed?.id].filter((id): id is string => !!id);
    const unread = ids.filter((id) => inbox.find((n) => n.id === id)?.read === false);
    const countBefore = await data<{ unread: number }>(ctx, "GET", "/v1/notifications/count");
    await data(ctx, "POST", "/v1/notifications/read", { ids });
    inbox = await notifications(ctx);
    ctx.check(
      ids.every((id) => inbox.find((n) => n.id === id)?.read === true),
      "marked read",
      ids.join(", "),
    );
    const countAfter = await data<{ unread: number }>(ctx, "GET", "/v1/notifications/count");
    // Other journeys can add items meanwhile, so the count is evidence, not a check.
    ctx.note(`unread ${countBefore.unread} -> ${countAfter.unread} (${unread.length} marked)`);
    await clarify(ctx, change.id, { action: "withdraw" });
    ctx.note("approval_required is checked in A11");
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Runner                                                                                      */
/* ------------------------------------------------------------------------------------------ */

type Journey = {
  id: string;
  title: string;
  /** Builds this journey runs at the same time (0: no Sandbox and no planning). */
  builds: number;
  timeoutMin: number;
  /** Journeys on the shared counter app run one at a time, in this order. */
  shared?: boolean;
  run: (ctx: Ctx) => Promise<void>;
};

const JOURNEYS: Journey[] = [
  {
    id: "A1",
    title: "clear request ships and auto-promotes",
    builds: 1,
    timeoutMin: 35,
    shared: true,
    run: a1,
  },
  { id: "A2", title: "unclear request, answer, build", builds: 1, timeoutMin: 35, run: a2 },
  { id: "A3", title: "unclear request, proceed anyway", builds: 1, timeoutMin: 15, run: a3 },
  { id: "A4", title: "unclear request, withdraw", builds: 0, timeoutMin: 10, run: a4 },
  { id: "A5", title: "duplicate of an open request", builds: 1, timeoutMin: 20, run: a5 },
  {
    id: "A6",
    title: "duplicate of a shipped feature",
    builds: 0,
    timeoutMin: 45,
    shared: true,
    run: a6,
  },
  {
    id: "A7",
    title: "two independent requests ship in sequence",
    builds: 2,
    timeoutMin: 60,
    run: a7,
  },
  {
    id: "A8",
    title: "two conflicting requests, same requester",
    builds: 2,
    timeoutMin: 20,
    run: a8,
  },
  { id: "A9", title: "cancel a running Change", builds: 1, timeoutMin: 20, run: a9 },
  { id: "A10", title: "budget stop and raise", builds: 1, timeoutMin: 40, run: a10 },
  { id: "A11", title: "human approval: approve and reject", builds: 1, timeoutMin: 70, run: a11 },
  {
    id: "A12",
    title: "rollback to an earlier generation",
    builds: 1,
    timeoutMin: 45,
    shared: true,
    run: a12,
  },
  {
    id: "A13",
    title: "remove app and publish again",
    builds: 0,
    timeoutMin: 45,
    shared: true,
    run: a13,
  },
  {
    id: "A14",
    title: "code edit through the API ships",
    builds: 1,
    timeoutMin: 45,
    shared: true,
    run: a14,
  },
  {
    id: "A15",
    title: "release failure injection and recovery",
    builds: 1,
    timeoutMin: 45,
    shared: true,
    run: a15,
  },
  { id: "A16", title: "settings: name and default budget", builds: 0, timeoutMin: 5, run: a16 },
  { id: "A17", title: "delete a Project and its cleanup", builds: 0, timeoutMin: 15, run: a17 },
  {
    id: "A18",
    title: "notifications and mark read",
    builds: 0,
    timeoutMin: 45,
    shared: true,
    run: a18,
  },
];

/** Shared journeys in the order that keeps the counter app's generations meaningful. */
const SHARED_ORDER = ["A1", "A6", "A14", "A12", "A15", "A13", "A18"];

type Result = {
  id: string;
  title: string;
  status: "PASS" | "FAIL" | "SKIP";
  ms: number;
  detail: string;
};
const results: Result[] = [];

async function meters(): Promise<Meters | null> {
  const projects = await call<{ data: { id: string }[] }>("GET", "/v1/projects?limit=1");
  const id = projects.json?.data?.[0]?.id;
  if (!id) return null;
  const cost = await call<{ data: { meters: Meters } }>("GET", `/v1/projects/${id}/cost`);
  return cost.json?.data?.meters ?? null;
}

/** Null when spending is allowed, else the reason to skip. */
async function spendStop(): Promise<string | null> {
  const m = await meters();
  if (!m) return null;
  const line = `Anthropic $${m.anthropicSpentUsdMonth.toFixed(2)}, Sandbox ${(m.sandboxSecondsMonth / 3600).toFixed(1)} h, ${m.agentModelCallsToday}/${m.agentDailyCallCap} model calls today`;
  console.log(`  [guard] ${line}`);
  if (m.anthropicSpentUsdMonth > MAX_ANTHROPIC_MONTH_USD) return `spend guard: ${line}`;
  if (m.sandboxSecondsMonth > MAX_SANDBOX_SECONDS_MONTH) return `spend guard: ${line}`;
  if (m.agentDailyCallCap - m.agentModelCallsToday < MIN_MODEL_CALLS_LEFT_TODAY) {
    return `spend guard: ${line}`;
  }
  return null;
}

async function runJourney(j: Journey) {
  const ctx = new Ctx(j.id);
  // A shared journey builds only when the counter app does not exist yet.
  if (j.builds > 0 || (j.shared && !baseBuild)) {
    const stop = await spendStop();
    if (stop) {
      results.push({ id: j.id, title: j.title, status: "SKIP", ms: 0, detail: stop });
      console.log(`SKIP  ${j.id}  ${stop}`);
      return;
    }
  }
  console.log(`start ${j.id}  ${j.title}`);
  const timer = setTimeout(
    () => ctx.controller.abort(`timed out after ${j.timeoutMin} min while ${ctx.step}`),
    j.timeoutMin * MINUTE,
  );
  let result: Result;
  try {
    await Promise.race([j.run(ctx), ctx.aborted]);
    result = { id: j.id, title: j.title, status: "PASS", ms: 0, detail: ctx.evidence.join("; ") };
  } catch (error) {
    const reason = error instanceof JourneyFailure ? error.message : String(error);
    result = {
      id: j.id,
      title: j.title,
      status: "FAIL",
      ms: 0,
      detail: `${reason} | evidence: ${ctx.evidence.join("; ")}`,
    };
  } finally {
    clearTimeout(timer);
    if (!ctx.signal.aborted) ctx.controller.abort("journey ended");
    for (const id of ctx.projects) await removeProject(id, j.id);
  }
  result.ms = Date.now() - ctx.started;
  results.push(result);
  console.log(`${result.status}  ${j.id}  ${minutes(result.ms)}  ${result.detail}`);
}

/** At most MAX_PARALLEL_BUILDS builds at a time, started in list order. */
function semaphore(capacity: number) {
  let free = capacity;
  const queue: { need: number; go: () => void }[] = [];
  const pump = () => {
    while (queue.length > 0 && (queue[0]?.need ?? 0) <= free) {
      const next = queue.shift();
      if (!next) break;
      free -= next.need;
      next.go();
    }
  };
  return async (need: number, fn: () => Promise<void>) => {
    const n = Math.min(need, capacity);
    if (n > 0) {
      await new Promise<void>((go) => {
        queue.push({ need: n, go });
        pump();
      });
    }
    try {
      await fn();
    } finally {
      free += n;
      pump();
    }
  };
}

const wanted = (process.argv[3] ?? "all").toUpperCase();
const ids = wanted === "ALL" ? JOURNEYS.map((j) => j.id) : wanted.split(",").map((s) => s.trim());
const unknown = ids.filter((id) => !JOURNEYS.some((j) => j.id === id));
if (unknown.length > 0) {
  console.error(
    `Unknown journeys: ${unknown.join(", ")}. Known: ${JOURNEYS.map((j) => j.id).join(", ")}`,
  );
  await session.close();
  process.exit(2);
}
const selected = JOURNEYS.filter((j) => ids.includes(j.id));
const shared = SHARED_ORDER.map((id) => selected.find((j) => j.id === id)).filter(
  (j): j is Journey => !!j,
);
const own = selected.filter((j) => !j.shared).sort((x, y) => y.builds - x.builds);

console.log(`journeys ${selected.map((j) => j.id).join(",")} on ${base}`);
const slots = semaphore(MAX_PARALLEL_BUILDS);
try {
  await Promise.all([
    shared.length > 0
      ? slots(1, async () => {
          for (const j of shared) await runJourney(j);
        })
      : Promise.resolve(),
    ...own.map((j) => slots(j.builds, () => runJourney(j))),
  ]);
} finally {
  for (const id of sharedProjects) await removeProject(id, "base");
  await session.close().catch(() => {});
}

const order = new Map(JOURNEYS.map((j, i) => [j.id, i]));
results.sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0));
console.log(`\nsummary (${minutes(Date.now() - runStart)})`);
for (const r of results) {
  console.log(`${r.status.padEnd(4)}  ${r.id.padEnd(3)}  ${minutes(r.ms).padStart(6)}  ${r.title}`);
}
const failed = results.filter((r) => r.status !== "PASS").length;
process.exit(failed > 0 ? 1 : 0);
