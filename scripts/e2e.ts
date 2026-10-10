/**
 * End-to-end check of every public API endpoint (AGENTS.md section 16) against a deployed
 * environment, with real requests: status codes, error codes, and response shapes (the Zod
 * schemas of packages/protocol where they exist; a small structural check otherwise).
 * Usage: bun run e2e <dev|prod>
 *
 * Signs in as the Clerk smoke user of that environment's Clerk instance: Keychain
 * `rhumbatron-clerk-secret-key-<env>` and `rhumbatron-clerk-smoke-user-id-<env>` (or
 * CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID). A development instance mints session tokens with the
 * Backend API. A production instance does not allow that, and prod rejects tokens without `azp`,
 * so there the run signs in through a one-time sign-in token on the Frontend API, from the app
 * origin. Secrets and tokens are never printed.
 *
 * No model spend: every Change is created with `startPlanning: false`, and no route that starts a
 * Sandbox, a Candidate, provisioning, or a fixture publication is called on an active Change.
 * Fixture routes are checked only where FIXTURES_ENABLED answers them. Every Project the run
 * creates is archived at the end, also when a check fails. Cost per run: about 120 API requests,
 * about 15 D1 row writes, 1 cleanup Queue message.
 */

import { $ } from "bun";
import {
  ApiErrorBody,
  apiData,
  Change,
  ChangeClaims,
  ChangeCommandOutcome,
  ChangeDetail,
  FeedPage,
  HealthResponse,
  Project,
  ProjectReleases,
  ProjectStats,
  RunProgress,
  VersionResponse,
} from "../packages/protocol/src/index.ts";
import { ProjectViewSnapshot } from "../workers/coordinator/src/view-model.ts";

const apis: Record<string, string> = {
  dev: "https://api-dev.rhumbatron.com",
  prod: "https://api.rhumbatron.com",
};

const environment = process.argv[2] ?? "";
const base = apis[environment] ?? "";
if (!base) {
  console.error(`Usage: bun scripts/e2e.ts <${Object.keys(apis).join("|")}>`);
  process.exit(2);
}

const keychain = async (service: string) =>
  (await $`security find-generic-password -s ${service} -w`.quiet().nothrow().text()).trim();
const secretKey =
  process.env.CLERK_SECRET_KEY || (await keychain(`rhumbatron-clerk-secret-key-${environment}`));
const userId =
  process.env.CLERK_SMOKE_USER_ID ||
  (await keychain(`rhumbatron-clerk-smoke-user-id-${environment}`));
if (!secretKey || !userId) {
  console.error(
    `No Clerk smoke credentials for ${environment}: add the Keychain items rhumbatron-clerk-secret-key-${environment} and rhumbatron-clerk-smoke-user-id-${environment}.`,
  );
  process.exit(2);
}

/* ------------------------------------------------------------------------------------------ */
/* Clerk sign-in                                                                               */
/* ------------------------------------------------------------------------------------------ */

type Session = { token(): Promise<string>; close(): Promise<void> };

/** Clerk session tokens live 60 seconds. Reuse one for at most this long. */
const TOKEN_REUSE_MS = 30_000;

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

function cached(mint: () => Promise<string>): () => Promise<string> {
  let token = "";
  let at = 0;
  return async () => {
    if (!token || Date.now() - at > TOKEN_REUSE_MS) {
      token = await mint();
      at = Date.now();
    }
    return token;
  };
}

/** Development instance: Backend API session and tokens (same as scripts/inject/client.ts). */
async function backendSession(sessionId: string): Promise<Session> {
  return {
    token: cached(async () => {
      const r = await clerkBackend("POST", `/sessions/${sessionId}/tokens`, {});
      if (r.status !== 200) throw new Error(`Clerk session token returned ${r.status}`);
      return r.json.jwt as string;
    }),
    async close() {
      await clerkBackend("POST", `/sessions/${sessionId}/revoke`);
    },
  };
}

/**
 * Production instance: a one-time sign-in token, redeemed on the Frontend API from the app origin,
 * so the session token carries `azp` like a browser session. Fresh tokens come from the same
 * Frontend API client; the Backend API revokes the session at the end.
 */
async function ticketSession(): Promise<Session> {
  const domains = await clerkBackend("GET", "/domains");
  const domain = (
    (domains.json.data ?? []) as { name: string; frontend_api_url: string; is_satellite: boolean }[]
  ).find((d) => !d.is_satellite);
  if (!domain) throw new Error(`Clerk domains returned ${domains.status} with no primary domain`);
  const origin = `https://${domain.name}`;
  const fapi = domain.frontend_api_url;

  const ticket = await clerkBackend("POST", "/sign_in_tokens", {
    user_id: userId,
    expires_in_seconds: 120,
  });
  if (ticket.status !== 200) throw new Error(`Clerk sign-in token returned ${ticket.status}`);
  const signIn = await fetch(`${fapi}/v1/client/sign_ins`, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ strategy: "ticket", ticket: ticket.json.token as string }),
    signal: AbortSignal.timeout(20_000),
  });
  const signed = (await signIn.json()) as {
    response?: { status?: string; created_session_id?: string };
  };
  const sessionId = signed.response?.created_session_id;
  if (signIn.status !== 200 || signed.response?.status !== "complete" || !sessionId) {
    throw new Error(`Clerk ticket sign-in returned ${signIn.status} ${signed.response?.status}`);
  }
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return {
    token: cached(async () => {
      const r = await fetch(`${fapi}/v1/client/sessions/${sessionId}/tokens`, {
        method: "POST",
        headers: { origin, cookie },
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await r.json()) as { jwt?: string };
      if (r.status !== 200 || !body.jwt)
        throw new Error(`Clerk session token returned ${r.status}`);
      return body.jwt;
    }),
    async close() {
      await clerkBackend("POST", `/sessions/${sessionId}/revoke`);
    },
  };
}

async function signIn(): Promise<Session> {
  const created = await clerkBackend("POST", "/sessions", { user_id: userId });
  if (created.status === 200) return backendSession(created.json.id as string);
  const code = (created.json.errors as { code?: string }[] | undefined)?.[0]?.code;
  if (code === "request_invalid_for_environment") return ticketSession();
  throw new Error(`Clerk session returned ${created.status} ${code ?? ""}`);
}

/* ------------------------------------------------------------------------------------------ */
/* Requests and checks                                                                         */
/* ------------------------------------------------------------------------------------------ */

type Res = { status: number; json: unknown; text: string };

let passed = 0;
let failed = 0;
let skipped = 0;

function report(name: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${!ok && detail ? `  ${detail}` : ""}`);
}

function skip(name: string, reason: string) {
  skipped++;
  console.log(`skip  ${name}  ${reason}`);
}

let session: Session | null = null;

/** `auth`: true sends the smoke user's token, false sends none, a string sends that header. */
async function call(
  method: string,
  path: string,
  opts: {
    body?: unknown;
    raw?: string;
    auth?: boolean | string;
    headers?: Record<string, string>;
  } = {},
): Promise<Res> {
  const headers = new Headers(opts.headers);
  const auth = opts.auth ?? true;
  if (auth === true && session) headers.set("authorization", `Bearer ${await session.token()}`);
  if (typeof auth === "string") headers.set("authorization", auth);
  let body: string | undefined;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.body !== undefined) body = JSON.stringify(opts.body);
  if (body !== undefined) headers.set("content-type", "application/json");
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text };
  } catch (error) {
    return { status: 0, json: undefined, text: String(error) };
  }
}

type Parser = {
  safeParse(v: unknown): {
    success: boolean;
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  };
};

/**
 * Structural spec for responses whose Zod schema is local to the API Worker: a type list such as
 * "string|null", a nested object spec, or a one-element array spec for every element.
 */
type Spec = string | { [key: string]: Spec } | [Spec];

function specErrors(value: unknown, spec: Spec, path = "$"): string[] {
  if (typeof spec === "string") {
    const kinds = spec.split("|");
    const kind =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : Number.isInteger(value)
            ? "integer"
            : typeof value;
    const ok =
      kinds.includes(kind) ||
      (kind === "integer" && kinds.includes("number")) ||
      (kinds.includes("any") && value !== undefined);
    return ok ? [] : [`${path}: expected ${spec}, got ${kind}`];
  }
  if (Array.isArray(spec)) {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    return value.flatMap((v, i) => specErrors(v, spec[0], `${path}[${i}]`));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${path}: expected object`];
  }
  const record = value as Record<string, unknown>;
  return Object.entries(spec).flatMap(([k, s]) => specErrors(record[k], s, `${path}.${k}`));
}

function shapeProblem(json: unknown, shape: Parser | Spec): string | null {
  if (typeof shape === "object" && shape !== null && "safeParse" in shape) {
    const result = (shape as Parser).safeParse(json);
    if (result.success) return null;
    const issue = result.error?.issues[0];
    return issue ? `shape: ${issue.path.join(".") || "$"} ${issue.message}` : "shape mismatch";
  }
  const errors = specErrors(json, shape as Spec);
  return errors.length === 0 ? null : `shape: ${errors.slice(0, 2).join("; ")}`;
}

const brief = (r: Res) => `${r.status} ${r.text.replace(/\s+/g, " ").slice(0, 200)}`;

/** Status, then shape, then an optional extra assertion that returns a problem or null. */
function expect(
  name: string,
  r: Res,
  status: number,
  shape?: Parser | Spec,
  extra?: (json: unknown) => string | null,
): boolean {
  if (r.status !== status) {
    report(name, false, `expected ${status}, got ${brief(r)}`);
    return false;
  }
  const problem = (shape ? shapeProblem(r.json, shape) : null) ?? extra?.(r.json) ?? null;
  report(name, problem === null, problem ?? "");
  return problem === null;
}

/** An error response: status, the ApiErrorBody shape, and the error code. */
function expectError(
  name: string,
  r: Res,
  status: number,
  code: string,
  extra?: (json: unknown) => string | null,
) {
  return expect(name, r, status, ApiErrorBody, (json) => {
    const actual = (json as { error: { code: string } }).error.code;
    if (actual !== code) return `expected error code ${code}, got ${actual}`;
    return extra?.(json) ?? null;
  });
}

const data = <T>(r: Res) => (r.json as { data: T }).data;
const errorDetails = (json: unknown) =>
  (json as { error: { details?: { reason?: string } } }).error.details;
const same = (label: string, actual: unknown, expected: unknown) =>
  actual === expected
    ? null
    : `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;

/* ------------------------------------------------------------------------------------------ */
/* Response shapes local to the API Worker                                                     */
/* ------------------------------------------------------------------------------------------ */

const ProjectListItem: Spec = {
  id: "string",
  name: "string",
  slug: "string",
  status: "string",
  canonicalGeneration: "integer",
  createdAt: "string",
};
const ChangeListItem: Spec = {
  id: "string",
  goal: "string",
  status: "string",
  riskTier: "string|null",
  budgetUsd: "number",
  createdAt: "string",
  taskCount: "integer",
  completedCount: "integer",
};
const AgentsPage: Spec = {
  data: {
    agents: "array",
    sleeping: { total: "integer", unlisted: [{ role: "string", count: "integer" }] },
    notWoken: "integer",
    totals: {
      agents: "integer",
      active: "integer",
      runs: "integer",
      escalations: "integer",
      modelCalls: "integer",
      costUsd: "number",
    },
    today: { day: "string", accountCalls: "integer", cap: "integer", projectCalls: "integer" },
    recentHours: "integer",
    feed: { available: "boolean" },
  },
};
const CostView: Spec = {
  data: {
    generatedAt: "string",
    changes: [
      {
        id: "string",
        goal: "string",
        status: "string",
        budgetUsd: "number",
        createdAt: "string",
        runs: "integer",
        modelCalls: "integer",
        costUsd: "number",
      },
    ],
    selected: "object|null",
    meters: {
      day: "string",
      month: "string",
      agentModelCallsToday: "integer",
      agentDailyCallCap: "integer",
      sandboxSecondsMonth: "integer",
      sandboxMonthlyCapSeconds: "integer",
      agentModelCallsByDay: [{ day: "string", count: "integer" }],
    },
    callCapPerRun: { haiku: "integer", sonnet: "integer", opus: "integer" },
  },
};
const NotificationItem: Spec = {
  id: "string",
  kind: "string",
  severity: "string",
  title: "string",
  body: "string",
  projectId: "string",
  projectName: "string",
  href: "string",
  createdAt: "string",
  read: "boolean",
};
const OperatorView: Spec = { data: { deadLetters: "array", limits: "array" } };
const ProductGraph: Spec = {
  data: {
    projectId: "string",
    canonicalGeneration: "integer|null",
    policyVersion: "string",
    protectedResources: ["string"],
    source: { kind: "string" },
    fixture: { applied: "boolean" },
    changes: [{ id: "string", goal: "string", status: "string", createdAt: "string" }],
    nodes: "array",
    edges: "array",
    counts: {
      tasks: "integer",
      intents: "integer",
      dependencies: "integer",
      changeSets: "integer",
      conflicts: "integer",
    },
    truncated: "boolean",
  },
};
const VerificationView: Spec = {
  data: {
    candidates: "array",
    evidence: "array",
    changes: [{ id: "string", goal: "string", status: "string", riskTier: "string|null" }],
    limit: "integer",
    evidenceTruncated: "boolean",
  },
};
const WorkspaceView: Spec = {
  data: {
    canonical: {
      assigned: "boolean",
      generation: "integer",
      artifactRef: "string",
      treeSha: "string",
      lastPromotedCandidateId: "string|null",
      updatedAt: "string|null",
    },
    changes: [
      {
        id: "string",
        goal: "string",
        status: "string",
        baseGeneration: "integer",
        createdAt: "string",
      },
    ],
    truncated: "boolean",
    workspaces: "array",
    candidates: "array",
  },
};
const FixtureView: Spec = {
  data: {
    changeId: "string",
    changeSets: [
      {
        design: "string",
        taskKey: "string",
        title: "string",
        changeSetId: "string",
        status: "string|null",
        artifactRef: "string|null",
      },
    ],
  },
};
const ArchiveView: Spec = {
  data: {
    id: "string",
    status: "string",
    archivedAt: "string",
    cleanedAt: "string|null",
    cleanupQueued: "boolean",
  },
};

/* ------------------------------------------------------------------------------------------ */
/* Live endpoint                                                                               */
/* ------------------------------------------------------------------------------------------ */

type LiveResult = { opened: boolean; first?: unknown; error?: string; closed: boolean };

/** Opens the live socket, waits for the first message, closes, and waits for the close. */
async function live(path: string, auth: boolean): Promise<LiveResult> {
  const url = `${base.replace(/^http/, "ws")}${path}`;
  const headers: Record<string, string> = {};
  if (auth && session) headers.authorization = `Bearer ${await session.token()}`;
  return new Promise<LiveResult>((resolve) => {
    const result: LiveResult = { opened: false, closed: false };
    // Bun accepts request headers on a client WebSocket; a browser would not.
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    const timer = setTimeout(() => {
      result.error = result.error ?? "timed out";
      try {
        ws.close();
      } catch {}
      resolve(result);
    }, 15_000);
    ws.onopen = () => {
      result.opened = true;
    };
    ws.onmessage = (event) => {
      if (result.first !== undefined) return;
      try {
        result.first = JSON.parse(String(event.data));
      } catch {
        result.first = String(event.data);
      }
      ws.close(1000, "e2e done");
    };
    ws.onerror = (event) => {
      result.error = (event as ErrorEvent).message || "socket error";
    };
    ws.onclose = () => {
      result.closed = true;
      clearTimeout(timer);
      resolve(result);
    };
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Run                                                                                         */
/* ------------------------------------------------------------------------------------------ */

const created: string[] = [];
const archived = new Set<string>();
const unknownProject = `proj_${crypto.randomUUID()}`;
const unknownChange = `chg_${crypto.randomUUID()}`;
const unknownCandidate = `cand_${crypto.randomUUID().replaceAll("-", "")}`;
const unknownDeadLetter = `dl_${crypto.randomUUID().replaceAll("-", "")}`;
const unknownTask = `tsk_${crypto.randomUUID()}`;

async function run() {
  console.log(`E2E ${environment}: ${base}\n`);

  // Public routes.
  expect("GET /health", await call("GET", "/health", { auth: false }), 200, HealthResponse, (j) =>
    same("service", (j as { service: string }).service, `rhumbatron-api-${environment}`),
  );
  expect(
    "GET /v1/version",
    await call("GET", "/v1/version", { auth: false }),
    200,
    VersionResponse,
  );
  expectError("unknown route is 404", await call("GET", "/v1/e2e-no-such-route"), 404, "not_found");

  // Auth required on every authenticated route. Fixture routes answer 404 before auth where
  // fixtures are off, so they are checked further down.
  const p = unknownProject;
  const ch = unknownChange;
  const cand = unknownCandidate;
  const authRoutes: [string, string][] = [
    ["GET", "/v1/projects"],
    ["POST", "/v1/projects"],
    ["GET", `/v1/projects/${p}`],
    ["DELETE", `/v1/projects/${p}`],
    ["GET", `/v1/projects/${p}/snapshot`],
    ["GET", `/v1/projects/${p}/changes`],
    ["POST", `/v1/projects/${p}/changes`],
    ["POST", `/v1/projects/${p}/provision`],
    ["POST", `/v1/projects/${p}/sandbox-smoke`],
    ["GET", `/v1/projects/${p}/agents`],
    ["GET", `/v1/projects/${p}/cost`],
    ["GET", `/v1/projects/${p}/events`],
    ["GET", `/v1/projects/${p}/stats`],
    ["GET", `/v1/projects/${p}/releases`],
    ["GET", `/v1/projects/${p}/dead-letters`],
    ["GET", `/v1/projects/${p}/product-graph`],
    ["GET", `/v1/projects/${p}/verification`],
    ["GET", `/v1/projects/${p}/workspace`],
    ["GET", `/v1/projects/${p}/workspace/files`],
    ["GET", `/v1/projects/${p}/live`],
    ["GET", `/v1/changes/${ch}`],
    ["POST", `/v1/changes/${ch}/cancel`],
    ["POST", `/v1/changes/${ch}/budget`],
    ["POST", `/v1/changes/${ch}/approve`],
    ["GET", `/v1/changes/${ch}/tasks`],
    ["GET", `/v1/changes/${ch}/candidates`],
    ["POST", `/v1/changes/${ch}/candidates`],
    ["GET", `/v1/changes/${ch}/events`],
    ["GET", `/v1/changes/${ch}/claims`],
    ["GET", `/v1/changes/${ch}/progress`],
    ["GET", `/v1/changes/${ch}/conflicts`],
    ["GET", `/v1/changes/${ch}/decisions`],
    ["GET", `/v1/candidates/${cand}`],
    ["POST", `/v1/candidates/${cand}/promote`],
    ["GET", `/v1/candidates/${cand}/evidence`],
    ["GET", `/v1/candidates/${cand}/evidence/build/output`],
    ["GET", `/v1/candidates/${cand}/evidence/browser/screenshots/1`],
    ["GET", `/v1/tasks/${unknownTask}/workspace`],
    ["GET", "/v1/notifications"],
    ["GET", "/v1/notifications/count"],
    ["POST", "/v1/notifications/read"],
    ["POST", `/v1/dead-letters/${unknownDeadLetter}/retry`],
    ["POST", `/v1/dead-letters/${unknownDeadLetter}/dismiss`],
  ];
  const unauthorized: string[] = [];
  for (const [method, path] of authRoutes) {
    const r = await call(method, path, { auth: false, body: method === "GET" ? undefined : {} });
    const code = (r.json as { error?: { code?: string } } | undefined)?.error?.code;
    if (r.status !== 401 || code !== "unauthorized")
      unauthorized.push(`${method} ${path} -> ${r.status}`);
  }
  report(
    `${authRoutes.length} routes answer 401 without a session token`,
    unauthorized.length === 0,
    unauthorized.slice(0, 4).join("; "),
  );
  expectError(
    "invalid session token is 401",
    await call("GET", "/v1/projects", { auth: "Bearer e2e.invalid.token" }),
    401,
    "unauthorized",
  );
  expectError(
    "non-Bearer authorization is 401",
    await call("GET", "/v1/projects", { auth: "Basic ZTJlOmUyZQ==" }),
    401,
    "unauthorized",
  );

  session = await signIn();
  report("Clerk smoke user signed in", true);

  // Projects.
  const slug = `e2e-${Date.now()}`;
  const createdProject = await call("POST", "/v1/projects", {
    body: { name: "E2E Project", slug },
  });
  if (createdProject.status === 201) created.push(data<{ id: string }>(createdProject).id);
  const okProject = expect(
    "POST /v1/projects creates a Project",
    createdProject,
    201,
    apiData(Project),
    (j) => {
      const project = (j as { data: Project }).data;
      return (
        same("slug", project.slug, slug) ??
        same("status", project.status, "active") ??
        same("generation", project.canonical.generation, 0)
      );
    },
  );
  if (!okProject) throw new Error("Project creation failed; later checks need it");
  const projectId = created[0] as string;

  expectError(
    "POST /v1/projects duplicate slug is 409",
    await call("POST", "/v1/projects", { body: { name: "E2E Project", slug } }),
    409,
    "conflict",
  );
  expectError(
    "POST /v1/projects invalid slug is 400",
    await call("POST", "/v1/projects", { body: { name: "E2E", slug: "Not A Slug" } }),
    400,
    "invalid_request",
  );
  expectError(
    "POST /v1/projects missing name is 400",
    await call("POST", "/v1/projects", { body: { slug: `${slug}-x` } }),
    400,
    "invalid_request",
  );
  expectError(
    "POST /v1/projects unknown template is 400",
    await call("POST", "/v1/projects", { body: { name: "E2E", slug: `${slug}-y`, template: "x" } }),
    400,
    "invalid_request",
  );
  expectError(
    "POST /v1/projects malformed JSON is 400",
    await call("POST", "/v1/projects", { raw: "{not json" }),
    400,
    "invalid_request",
  );
  expect(
    "GET /v1/projects lists the Project",
    await call("GET", "/v1/projects?limit=200"),
    200,
    { data: [ProjectListItem] },
    (j) =>
      (j as { data: { id: string }[] }).data.some((x) => x.id === projectId)
        ? null
        : "new Project missing from the list",
  );
  expectError(
    "GET /v1/projects limit=0 is 400",
    await call("GET", "/v1/projects?limit=0"),
    400,
    "invalid_request",
  );
  expect(
    "GET /v1/projects/:id",
    await call("GET", `/v1/projects/${projectId}`),
    200,
    apiData(Project),
    (j) => same("id", (j as { data: Project }).data.id, projectId),
  );
  expectError(
    "GET /v1/projects/:id unknown is 404",
    await call("GET", `/v1/projects/${unknownProject}`),
    404,
    "not_found",
  );
  expectError(
    "GET /v1/projects/:id malformed is 400",
    await call("GET", "/v1/projects/NOT_AN_ID"),
    400,
    "invalid_request",
  );

  // Snapshot.
  // `{ sequence, snapshot }`, built from protocol schemas: sequence is a non-negative integer.
  const snapshotShape = apiData(
    ProjectViewSnapshot.pick({}).extend({
      sequence: ProjectViewSnapshot.shape.canonicalGeneration,
      snapshot: ProjectViewSnapshot,
    }),
  );
  expect(
    "GET /v1/projects/:id/snapshot",
    await call("GET", `/v1/projects/${projectId}/snapshot`),
    200,
    snapshotShape,
    (j) =>
      same(
        "snapshot.project.id",
        (j as { data: { snapshot: ProjectViewSnapshot } }).data.snapshot.project.id,
        projectId,
      ),
  );
  expectError(
    "GET /v1/projects/:id/snapshot unknown is 404",
    await call("GET", `/v1/projects/${unknownProject}/snapshot`),
    404,
    "not_found",
  );

  // Changes.
  const changeBody = {
    goal: "E2E check change (no planning)",
    budgetUsd: 1,
    clientRequestId: `req-${slug}`,
    startPlanning: false,
  };
  const createdChange = await call("POST", `/v1/projects/${projectId}/changes`, {
    body: changeBody,
  });
  const okChange = expect(
    "POST /v1/projects/:id/changes creates a Change",
    createdChange,
    201,
    apiData(Change),
    (j) => {
      const change = (j as { data: Change }).data;
      return (
        same("status", change.status, "created") ??
        same("budgetUsd", change.budgetUsd, 1) ??
        same("projectId", change.projectId, projectId)
      );
    },
  );
  if (!okChange) throw new Error("Change creation failed; later checks need it");
  const changeId = data<Change>(createdChange).id;
  expect(
    "POST changes retry with the same clientRequestId is idempotent",
    await call("POST", `/v1/projects/${projectId}/changes`, { body: changeBody }),
    200,
    apiData(Change),
    (j) => same("id", (j as { data: Change }).data.id, changeId),
  );
  expectError(
    "POST changes empty goal is 400",
    await call("POST", `/v1/projects/${projectId}/changes`, {
      body: { goal: "", startPlanning: false },
    }),
    400,
    "invalid_request",
  );
  expectError(
    "POST changes budget over the cap is 400",
    await call("POST", `/v1/projects/${projectId}/changes`, {
      body: { goal: "E2E", budgetUsd: 1000, startPlanning: false },
    }),
    400,
    "invalid_request",
  );
  expectError(
    "POST changes on an unknown Project is 404",
    await call("POST", `/v1/projects/${unknownProject}/changes`, {
      body: { goal: "E2E", startPlanning: false },
    }),
    404,
    "not_found",
  );
  expect(
    "GET /v1/projects/:id/changes lists the Change",
    await call("GET", `/v1/projects/${projectId}/changes`),
    200,
    { data: [ChangeListItem] },
    (j) => {
      const list = (j as { data: { id: string }[] }).data;
      return list.length === 1 && list[0]?.id === changeId
        ? null
        : `expected exactly the new Change, got ${list.length}`;
    },
  );
  expect(
    "GET /v1/changes/:id",
    await call("GET", `/v1/changes/${changeId}`),
    200,
    apiData(ChangeDetail),
    (j) => {
      const change = (j as { data: ChangeDetail }).data;
      return same("id", change.id, changeId) ?? same("riskTier", change.riskTier, null);
    },
  );
  expectError(
    "GET /v1/changes/:id unknown is 404",
    await call("GET", `/v1/changes/${unknownChange}`),
    404,
    "not_found",
  );
  expectError(
    "GET /v1/changes/:id malformed is 400",
    await call("GET", "/v1/changes/not-a-change"),
    400,
    "invalid_request",
  );
  expect(
    "GET /v1/changes/:id/tasks (none without planning)",
    await call("GET", `/v1/changes/${changeId}/tasks`),
    200,
    { data: "array" },
    (j) => same("task count", (j as { data: unknown[] }).data.length, 0),
  );
  expectError(
    "GET /v1/changes/:id/tasks unknown is 404",
    await call("GET", `/v1/changes/${unknownChange}/tasks`),
    404,
    "not_found",
  );
  expect(
    "GET /v1/changes/:id/candidates (none)",
    await call("GET", `/v1/changes/${changeId}/candidates`),
    200,
    { data: "array" },
    (j) => same("candidate count", (j as { data: unknown[] }).data.length, 0),
  );
  expectError(
    "GET /v1/changes/:id/candidates unknown is 404",
    await call("GET", `/v1/changes/${unknownChange}/candidates`),
    404,
    "not_found",
  );
  expectError(
    "POST /v1/changes/:id/candidates invalid body is 400",
    await call("POST", `/v1/changes/${changeId}/candidates`, { body: { changeSetIds: "x" } }),
    400,
    "invalid_request",
  );
  expectError(
    "POST /v1/changes/:id/candidates unknown Change is 404",
    await call("POST", `/v1/changes/${unknownChange}/candidates`, { body: {} }),
    404,
    "not_found",
  );

  // Activity of one Change.
  expect(
    "GET /v1/changes/:id/events",
    await call("GET", `/v1/changes/${changeId}/events`),
    200,
    apiData(FeedPage),
  );
  expectError(
    "GET /v1/changes/:id/events after and before is 400",
    await call("GET", `/v1/changes/${changeId}/events?after=1&before=2`),
    400,
    "invalid_request",
  );
  expect(
    "GET /v1/changes/:id/claims",
    await call("GET", `/v1/changes/${changeId}/claims`),
    200,
    apiData(ChangeClaims),
  );
  expect(
    "GET /v1/changes/:id/progress",
    await call("GET", `/v1/changes/${changeId}/progress`),
    200,
    apiData(RunProgress.array()),
  );
  expect(
    "GET /v1/changes/:id/conflicts",
    await call("GET", `/v1/changes/${changeId}/conflicts`),
    200,
    { data: "array" },
  );
  expect(
    "GET /v1/changes/:id/decisions",
    await call("GET", `/v1/changes/${changeId}/decisions`),
    200,
    { data: { receipts: "array", truncated: "boolean" } },
  );
  for (const sub of ["events", "claims", "progress", "conflicts", "decisions"]) {
    expectError(
      `GET /v1/changes/:id/${sub} unknown is 404`,
      await call("GET", `/v1/changes/${unknownChange}/${sub}`),
      404,
      "not_found",
    );
  }

  // Candidates, Evidence, approval, promotion, Task workspace: unknown IDs only (no spend).
  expectError(
    "GET /v1/candidates/:id unknown is 404",
    await call("GET", `/v1/candidates/${unknownCandidate}`),
    404,
    "not_found",
  );
  expectError(
    "GET /v1/candidates/:id malformed is 400",
    await call("GET", "/v1/candidates/cand_NOT-VALID"),
    400,
    "invalid_request",
  );
  expectError(
    "GET /v1/candidates/:id/evidence unknown is 404",
    await call("GET", `/v1/candidates/${unknownCandidate}/evidence`),
    404,
    "not_found",
  );
  expectError(
    "GET evidence output unknown is 404",
    await call("GET", `/v1/candidates/${unknownCandidate}/evidence/build/output`),
    404,
    "not_found",
  );
  expectError(
    "GET evidence screenshot unknown is 404",
    await call("GET", `/v1/candidates/${unknownCandidate}/evidence/browser/screenshots/1`),
    404,
    "not_found",
  );
  expectError(
    "GET evidence screenshot index out of range is 400",
    await call("GET", `/v1/candidates/${unknownCandidate}/evidence/browser/screenshots/99`),
    400,
    "invalid_request",
  );
  expectError(
    "POST /v1/candidates/:id/promote unknown is 404",
    await call("POST", `/v1/candidates/${unknownCandidate}/promote`),
    404,
    "not_found",
  );
  expectError(
    "POST /v1/changes/:id/approve invalid body is 400",
    await call("POST", `/v1/changes/${changeId}/approve`, { body: { decision: "maybe" } }),
    400,
    "invalid_request",
  );
  expectError(
    "POST /v1/changes/:id/approve unknown Candidate is 404",
    await call("POST", `/v1/changes/${changeId}/approve`, {
      body: { candidateId: unknownCandidate, decision: "approve" },
    }),
    404,
    "not_found",
  );
  expectError(
    "GET /v1/tasks/:id/workspace unknown is 404",
    await call("GET", `/v1/tasks/${unknownTask}/workspace`),
    404,
    "not_found",
  );

  // Budget raise on a non-blocked Change: recorded without a resume or dispatch, or refused.
  const raise = await call("POST", `/v1/changes/${changeId}/budget`, { body: { budgetUsd: 2 } });
  if (raise.status === 409) {
    expectError("POST budget on a non-blocked Change is refused", raise, 409, "conflict");
  } else {
    expect(
      "POST budget on a non-blocked Change is validated",
      raise,
      200,
      apiData(ChangeCommandOutcome),
      (j) => {
        const o = (j as { data: ChangeCommandOutcome }).data;
        if (o.status !== "recorded") return `expected recorded, got ${o.status}`;
        return (
          same("changeStatus", o.changeStatus, "created") ??
          same("budgetUsd", o.budgetUsd, 2) ??
          same("repeated", o.repeated, false) ??
          same("dispatched", o.dispatchedTaskIds.length, 0)
        );
      },
    );
    expect(
      "POST budget repeat of the same amount is a repeat",
      await call("POST", `/v1/changes/${changeId}/budget`, { body: { budgetUsd: 2 } }),
      200,
      apiData(ChangeCommandOutcome),
      (j) => {
        const o = (j as { data: ChangeCommandOutcome }).data;
        return o.status === "recorded" ? same("repeated", o.repeated, true) : `got ${o.status}`;
      },
    );
  }
  expectError(
    "POST budget lower than the current budget is 409",
    await call("POST", `/v1/changes/${changeId}/budget`, { body: { budgetUsd: 0.5 } }),
    409,
    "conflict",
    (j) => same("reason", errorDetails(j)?.reason, "budget_lower"),
  );
  expectError(
    "POST budget negative is 400",
    await call("POST", `/v1/changes/${changeId}/budget`, { body: { budgetUsd: -1 } }),
    400,
    "invalid_request",
  );
  expectError(
    "POST budget over the cap is 400",
    await call("POST", `/v1/changes/${changeId}/budget`, { body: { budgetUsd: 1000 } }),
    400,
    "invalid_request",
  );
  expectError(
    "POST budget missing amount is 400",
    await call("POST", `/v1/changes/${changeId}/budget`, { body: {} }),
    400,
    "invalid_request",
  );
  expectError(
    "POST budget unknown Change is 404",
    await call("POST", `/v1/changes/${unknownChange}/budget`, { body: { budgetUsd: 2 } }),
    404,
    "not_found",
  );
  expect(
    "GET /v1/changes/:id shows the budget",
    await call("GET", `/v1/changes/${changeId}`),
    200,
    apiData(ChangeDetail),
    (j) =>
      same("budgetUsd", (j as { data: ChangeDetail }).data.budgetUsd, raise.status === 200 ? 2 : 1),
  );

  // Project reads.
  expect(
    "GET /v1/projects/:id/agents",
    await call("GET", `/v1/projects/${projectId}/agents`),
    200,
    AgentsPage,
    (j) => same("agents", (j as { data: { agents: unknown[] } }).data.agents.length, 0),
  );
  expect(
    "GET /v1/projects/:id/cost",
    await call("GET", `/v1/projects/${projectId}/cost`),
    200,
    CostView,
    (j) => {
      const view = (j as { data: { changes: { id: string }[] } }).data;
      return view.changes.some((c) => c.id === changeId) ? null : "Change missing from cost";
    },
  );
  expect(
    "GET /v1/projects/:id/cost?changeId selects the Change",
    await call("GET", `/v1/projects/${projectId}/cost?changeId=${changeId}`),
    200,
    CostView,
    (j) =>
      same(
        "selected.changeId",
        (j as { data: { selected: { changeId: string } | null } }).data.selected?.changeId,
        changeId,
      ),
  );
  expectError(
    "GET /v1/projects/:id/cost malformed changeId is 400",
    await call("GET", `/v1/projects/${projectId}/cost?changeId=bad`),
    400,
    "invalid_request",
  );
  expect(
    "GET /v1/projects/:id/events",
    await call("GET", `/v1/projects/${projectId}/events`),
    200,
    apiData(FeedPage),
  );
  expectError(
    "GET /v1/projects/:id/events limit=0 is 400",
    await call("GET", `/v1/projects/${projectId}/events?limit=0`),
    400,
    "invalid_request",
  );
  expect(
    "GET /v1/projects/:id/stats",
    await call("GET", `/v1/projects/${projectId}/stats`),
    200,
    apiData(ProjectStats),
    (j) => same("changes.total", (j as { data: ProjectStats }).data.changes.total, 1),
  );
  expect(
    "GET /v1/projects/:id/releases (no target yet)",
    await call("GET", `/v1/projects/${projectId}/releases`),
    200,
    apiData(ProjectReleases),
    (j) => {
      const view = (j as { data: ProjectReleases }).data;
      return same("target", view.target, null) ?? same("releases", view.releases.length, 0);
    },
  );
  expectError(
    "GET /v1/projects/:id/releases limit=0 is 400",
    await call("GET", `/v1/projects/${projectId}/releases?limit=0`),
    400,
    "invalid_request",
  );
  expect(
    "GET /v1/projects/:id/dead-letters",
    await call("GET", `/v1/projects/${projectId}/dead-letters`),
    200,
    OperatorView,
  );
  expect(
    "GET /v1/projects/:id/dead-letters?changeId",
    await call("GET", `/v1/projects/${projectId}/dead-letters?changeId=${changeId}`),
    200,
    OperatorView,
  );
  expectError(
    "GET dead-letters malformed changeId is 400",
    await call("GET", `/v1/projects/${projectId}/dead-letters?changeId=bad`),
    400,
    "invalid_request",
  );
  for (const action of ["retry", "dismiss"]) {
    expectError(
      `POST /v1/dead-letters/:id/${action} unknown is 404`,
      await call("POST", `/v1/dead-letters/${unknownDeadLetter}/${action}`),
      404,
      "not_found",
    );
    expectError(
      `POST /v1/dead-letters/:id/${action} malformed is 400`,
      await call("POST", `/v1/dead-letters/dl_bad/${action}`),
      400,
      "invalid_request",
    );
  }
  expect(
    "GET /v1/projects/:id/product-graph",
    await call("GET", `/v1/projects/${projectId}/product-graph`),
    200,
    ProductGraph,
    (j) => same("projectId", (j as { data: { projectId: string } }).data.projectId, projectId),
  );
  expect(
    "GET /v1/projects/:id/verification",
    await call("GET", `/v1/projects/${projectId}/verification`),
    200,
    VerificationView,
  );
  expect(
    "GET /v1/projects/:id/workspace",
    await call("GET", `/v1/projects/${projectId}/workspace`),
    200,
    WorkspaceView,
    (j) =>
      same(
        "canonical.assigned",
        (j as { data: { canonical: { assigned: boolean } } }).data.canonical.assigned,
        false,
      ),
  );
  expectError(
    "GET workspace/files without canonical source is 404",
    await call("GET", `/v1/projects/${projectId}/workspace/files`),
    404,
    "not_found",
  );
  expectError(
    "GET workspace/files malformed tree is 400",
    await call("GET", `/v1/projects/${projectId}/workspace/files?tree=xyz`),
    400,
    "invalid_request",
  );
  expectError(
    "POST /v1/projects/:id/provision unknown template is 400",
    await call("POST", `/v1/projects/${projectId}/provision`, { body: { template: "nope" } }),
    400,
    "invalid_request",
  );
  for (const [method, sub] of [
    ["GET", "agents"],
    ["GET", "cost"],
    ["GET", "events"],
    ["GET", "stats"],
    ["GET", "releases"],
    ["GET", "dead-letters"],
    ["GET", "product-graph"],
    ["GET", "verification"],
    ["GET", "workspace"],
    ["GET", "workspace/files"],
    ["GET", "changes"],
    ["POST", "sandbox-smoke"],
    ["POST", "provision"],
    ["DELETE", ""],
  ] as const) {
    expectError(
      `${method} /v1/projects/:id${sub ? `/${sub}` : ""} unknown is 404`,
      await call(method, `/v1/projects/${unknownProject}${sub ? `/${sub}` : ""}`, {
        body: sub === "provision" ? { template: "empty" } : undefined,
      }),
      404,
      "not_found",
    );
  }

  // Notifications.
  expect("GET /v1/notifications", await call("GET", "/v1/notifications?limit=5"), 200, {
    data: { items: [NotificationItem], unread: "integer", action: "integer" },
  });
  expectError(
    "GET /v1/notifications limit=0 is 400",
    await call("GET", "/v1/notifications?limit=0"),
    400,
    "invalid_request",
  );
  expect("GET /v1/notifications/count", await call("GET", "/v1/notifications/count"), 200, {
    data: { unread: "integer", action: "integer" },
  });
  expect(
    "POST /v1/notifications/read marks one id",
    await call("POST", "/v1/notifications/read", { body: { ids: [`promoted:e2e_${slug}`] } }),
    200,
    { data: { marked: "integer" } },
    (j) => same("marked", (j as { data: { marked: number } }).data.marked, 1),
  );
  expectError(
    "POST /v1/notifications/read empty ids is 400",
    await call("POST", "/v1/notifications/read", { body: { ids: [] } }),
    400,
    "invalid_request",
  );

  // Releases of an existing release Project (target and list), when the smoke user has one.
  const all = await call("GET", "/v1/projects?limit=200");
  const live_ = ((all.json as { data?: { id: string; slug: string }[] })?.data ?? []).find(
    (x) => x.slug === "acme-shop-live",
  );
  if (live_) {
    expect(
      "GET releases of acme-shop-live has a target",
      await call("GET", `/v1/projects/${live_.id}/releases?limit=5`),
      200,
      apiData(ProjectReleases),
      (j) => ((j as { data: ProjectReleases }).data.target ? null : "target is null"),
    );
  } else {
    skip("GET releases with a target", "no acme-shop-live Project for this smoke user");
  }

  // Live endpoint.
  const opened = await live(`/v1/projects/${projectId}/live?afterSequence=0`, true);
  const first = opened.first as
    | { type?: string; sequence?: unknown; project?: unknown }
    | undefined;
  report("WS /v1/projects/:id/live opens", opened.opened, opened.error ?? "did not open");
  report(
    "WS live first message is a snapshot with a sequence",
    first?.type === "snapshot" &&
      typeof first.sequence === "number" &&
      ProjectViewSnapshot.safeParse(first.project).success,
    `got ${JSON.stringify(first ?? opened.error ?? null).slice(0, 200)}`,
  );
  report("WS live closes", opened.closed, opened.error ?? "not closed");
  const unknownLive = await live(`/v1/projects/${unknownProject}/live`, true);
  report("WS live for an unknown Project does not open", !unknownLive.opened, "opened");
  const anonymousLive = await live(`/v1/projects/${projectId}/live`, false);
  report("WS live without a session token does not open", !anonymousLive.opened, "opened");
  expectError(
    "GET live without a WebSocket upgrade is 426",
    await call("GET", `/v1/projects/${projectId}/live`),
    426,
    "invalid_request",
  );
  expectError(
    "GET live negative afterSequence is 400",
    await call("GET", `/v1/projects/${projectId}/live?afterSequence=-1`),
    400,
    "invalid_request",
  );

  // Fixture routes: detect FIXTURES_ENABLED from the read route.
  const fixtureRead = await call("GET", `/v1/changes/${changeId}/fixture-changesets`);
  const fixturesOn = fixtureRead.status === 200;
  if (!fixturesOn) {
    expectError(
      "fixture routes are absent (404) without FIXTURES_ENABLED",
      fixtureRead,
      404,
      "not_found",
      (j) =>
        same("message", (j as { error: { message: string } }).error.message, "Route not found"),
    );
    skip("fixture and release injection routes", "FIXTURES_ENABLED is off");
  } else {
    expect("GET /v1/changes/:id/fixture-changesets", fixtureRead, 200, FixtureView, (j) => {
      const sets = (j as { data: { changeSets: { status: unknown }[] } }).data.changeSets;
      return sets.length === 2 && sets.every((s) => s.status === null)
        ? null
        : "expected two unpublished designs";
    });
    expectError(
      "fixture-changesets without a session token is 401",
      await call("GET", `/v1/changes/${changeId}/fixture-changesets`, { auth: false }),
      401,
      "unauthorized",
    );
    expectError(
      "GET fixture-changesets unknown Change is 404",
      await call("GET", `/v1/changes/${unknownChange}/fixture-changesets`),
      404,
      "not_found",
    );
    expectError(
      "POST fixture-changesets invalid design is 400",
      await call("POST", `/v1/changes/${changeId}/fixture-changesets`, { body: { design: "c" } }),
      400,
      "invalid_request",
    );
    expectError(
      "POST releases/inject-failure without a target is 404",
      await call("POST", `/v1/projects/${projectId}/releases/inject-failure`),
      404,
      "not_found",
      (j) => same("reason", errorDetails(j)?.reason, "no_target"),
    );
  }

  // Cancel, then the Change is closed.
  expect(
    "POST /v1/changes/:id/cancel",
    await call("POST", `/v1/changes/${changeId}/cancel`),
    200,
    apiData(ChangeCommandOutcome),
    (j) => {
      const o = (j as { data: ChangeCommandOutcome }).data;
      if (o.status !== "recorded") return `expected recorded, got ${o.status}`;
      return (
        same("changeStatus", o.changeStatus, "cancelled") ?? same("repeated", o.repeated, false)
      );
    },
  );
  expect(
    "POST cancel repeat is a repeat",
    await call("POST", `/v1/changes/${changeId}/cancel`),
    200,
    apiData(ChangeCommandOutcome),
    (j) => {
      const o = (j as { data: ChangeCommandOutcome }).data;
      return o.status === "recorded" ? same("repeated", o.repeated, true) : `got ${o.status}`;
    },
  );
  expectError(
    "POST /v1/changes/:id/cancel unknown is 404",
    await call("POST", `/v1/changes/${unknownChange}/cancel`),
    404,
    "not_found",
  );
  expect(
    "GET /v1/changes/:id is cancelled",
    await call("GET", `/v1/changes/${changeId}`),
    200,
    apiData(ChangeDetail),
    (j) => same("status", (j as { data: ChangeDetail }).data.status, "cancelled"),
  );
  expectError(
    "POST budget on a cancelled Change is 409",
    await call("POST", `/v1/changes/${changeId}/budget`, { body: { budgetUsd: 3 } }),
    409,
    "conflict",
    (j) => same("reason", errorDetails(j)?.reason, "change_closed"),
  );
  if (fixturesOn) {
    expectError(
      "POST fixture-changesets on a cancelled Change is 409",
      await call("POST", `/v1/changes/${changeId}/fixture-changesets`, { body: { design: "a" } }),
      409,
      "conflict",
    );
  }

  // Archive.
  const archive = await call("DELETE", `/v1/projects/${projectId}`);
  if (archive.status === 200) archived.add(projectId);
  expect("DELETE /v1/projects/:id archives", archive, 200, ArchiveView, (j) =>
    same("status", (j as { data: { status: string } }).data.status, "archived"),
  );
  const archivedAt = (archive.json as { data?: { archivedAt?: string } })?.data?.archivedAt;
  expect(
    "DELETE archive repeat keeps the archive time",
    await call("DELETE", `/v1/projects/${projectId}`),
    200,
    ArchiveView,
    (j) => same("archivedAt", (j as { data: { archivedAt: string } }).data.archivedAt, archivedAt),
  );
  expect(
    "GET archived Project shows archived",
    await call("GET", `/v1/projects/${projectId}`),
    200,
    apiData(Project),
    (j) => same("status", (j as { data: Project }).data.status, "archived"),
  );
  expect(
    "GET /v1/projects hides the archived Project",
    await call("GET", "/v1/projects?limit=200"),
    200,
    { data: [ProjectListItem] },
    (j) =>
      (j as { data: { id: string }[] }).data.some((x) => x.id === projectId)
        ? "archived Project still listed"
        : null,
  );
  expect(
    "GET /v1/projects?include=archived lists it",
    await call("GET", "/v1/projects?limit=200&include=archived"),
    200,
    { data: [ProjectListItem] },
    (j) =>
      (j as { data: { id: string }[] }).data.some((x) => x.id === projectId)
        ? null
        : "archived Project missing",
  );
  expectError(
    "GET snapshot of an archived Project is 409",
    await call("GET", `/v1/projects/${projectId}/snapshot`),
    409,
    "conflict",
  );
  expectError(
    "POST changes on an archived Project is 409",
    await call("POST", `/v1/projects/${projectId}/changes`, {
      body: { goal: "E2E", startPlanning: false },
    }),
    409,
    "conflict",
  );
  expectError(
    "POST provision on an archived Project is 409",
    await call("POST", `/v1/projects/${projectId}/provision`, { body: { template: "empty" } }),
    409,
    "conflict",
  );
  expectError(
    "POST sandbox-smoke on an archived Project is 409",
    await call("POST", `/v1/projects/${projectId}/sandbox-smoke`),
    409,
    "conflict",
  );
}

try {
  await run();
} catch (error) {
  report("run completed", false, String(error).slice(0, 300));
} finally {
  for (const id of created.filter((x) => !archived.has(x))) {
    const r = await call("DELETE", `/v1/projects/${id}`);
    report(`cleanup: archive ${id}`, r.status === 200, brief(r));
  }
  await (session as Session | null)?.close().catch(() => {});
}

console.log(
  `\n${environment}: ${passed} passed, ${failed} failed, ${skipped} skipped (${passed + failed} checks).`,
);
process.exit(failed === 0 ? 0 : 1);
