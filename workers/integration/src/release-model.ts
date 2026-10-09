import type { EvidenceCoverage, EvidenceStatus, ReleaseStatus } from "@rhumbatron/protocol";

/**
 * Release decisions (AGENTS.md sections 21.3, 42.10, 60; ADR 0018). Pure except `runProbes`
 * (plain fetch, no bindings), so `scripts/smoke-release.ts` runs the same probes. The
 * ReleaseWorkflow feeds these functions what the Builds API and ProjectRootDO returned.
 * Deterministic. No model call decides whether a release is deployed (section 22.7).
 */

/** Section 60: one release per Project and Canonical Generation. Also the Workflow instance ID. */
export const releaseIdFor = (projectId: string, generation: number) =>
  `rel_${projectId}_${generation}`;

/**
 * Release smoke Evidence check IDs. The API leaves `release-*` rows out of Candidate verification
 * views; they never feed a promotion gate (only the plan's required check IDs do).
 */
export const releaseCheckId = (generation: number, injected = false) =>
  `release-s${generation}${injected ? "-injected" : ""}`;

/* ------------------------------------------------------------------------------------------ */
/* Status transitions                                                                          */
/* ------------------------------------------------------------------------------------------ */

const NEXT: Record<ReleaseStatus, readonly ReleaseStatus[]> = {
  queued: ["building", "failed", "superseded"],
  building: ["deployed", "failed", "smoke_failed", "superseded"],
  // Only failure injection (P13-12) re-checks a finished deployment.
  deployed: ["smoke_failed"],
  failed: [],
  smoke_failed: [],
  superseded: [],
};

export const canTransition = (from: ReleaseStatus, to: ReleaseStatus) => NEXT[from].includes(to);

/** SQL list of the statuses that may move to `to`, for an `UPDATE ... WHERE status IN (...)` guard. */
export function fromStatuses(to: ReleaseStatus): ReleaseStatus[] {
  return (Object.keys(NEXT) as ReleaseStatus[]).filter((from) => canTransition(from, to));
}

/**
 * Section 13.1 and 42.10 for releases: a release is for exactly one generation. When canonical has
 * moved past it before the release finished, the newer generation's release owns the Worker.
 */
export function supersededBy(releaseGeneration: number, canonicalGeneration: number) {
  return canonicalGeneration > releaseGeneration;
}

/* ------------------------------------------------------------------------------------------ */
/* Builds API                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** The fields of a Workers Builds build record this code reads (Builds API, 2026-10). */
export type BuildRecord = {
  build_uuid: string;
  status?: string | null;
  build_outcome?: string | null;
  created_on?: string | null;
  stopped_on?: string | null;
  build_trigger_metadata?: { commit_hash?: string | null; branch?: string | null } | null;
};

/** Full or abbreviated (at least 7 hex) commit hashes name the same commit. */
function sameCommit(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(x) || !/^[0-9a-f]{7,64}$/.test(y)) return false;
  return x.length >= y.length ? x.startsWith(y) : y.startsWith(x);
}

/**
 * The build of the promoted commit: the newest build whose trigger commit equals it. Builds of
 * other commits (older or newer generations) never match.
 */
export function matchBuild(builds: readonly BuildRecord[], commit: string): BuildRecord | null {
  const matching = builds.filter((b) => sameCommit(b.build_trigger_metadata?.commit_hash, commit));
  matching.sort(
    (a, b) => (Date.parse(b.created_on ?? "") || 0) - (Date.parse(a.created_on ?? "") || 0),
  );
  return matching[0] ?? null;
}

export type BuildPhase =
  | { phase: "building"; status: string }
  | { phase: "succeeded" }
  | { phase: "failed"; reason: string };

/** Builds API: status queued|initializing|running|stopped; outcome success|fail|skipped|cancelled|terminated. */
export function buildPhase(build: BuildRecord): BuildPhase {
  const status = (build.status ?? "").toLowerCase();
  if (status !== "stopped") return { phase: "building", status: status || "unknown" };
  const outcome = (build.build_outcome ?? "").toLowerCase();
  if (outcome === "success") return { phase: "succeeded" };
  return {
    phase: "failed",
    reason: `Workers Build ${build.build_uuid} stopped with outcome ${outcome || "unknown"}.`,
  };
}

/** Poll schedule: 15 s, 30 s, then every 60 s, within a 15-minute deadline. */
export const POLL_DEADLINE_MS = 15 * 60_000;
export function pollDelaySeconds(attempt: number) {
  return attempt <= 0 ? 15 : attempt === 1 ? 30 : 60;
}
/** Number of polls that fit in the deadline with that schedule (first poll at t = 0). */
export function maxPolls(deadlineMs = POLL_DEADLINE_MS) {
  let elapsed = 0;
  let polls = 1;
  while (elapsed + pollDelaySeconds(polls - 1) * 1000 <= deadlineMs) {
    elapsed += pollDelaySeconds(polls - 1) * 1000;
    polls++;
  }
  return polls;
}

/** The newest deployment's 100 % version from `GET /workers/scripts/:name/deployments`. */
export function activeVersionId(body: unknown): string | null {
  const deployments = (body as { result?: { deployments?: unknown } } | null)?.result?.deployments;
  if (!Array.isArray(deployments) || deployments.length === 0) return null;
  const sorted = [...deployments].sort(
    (a, b) =>
      (Date.parse((b as { created_on?: string }).created_on ?? "") || 0) -
      (Date.parse((a as { created_on?: string }).created_on ?? "") || 0),
  );
  const versions = (sorted[0] as { versions?: unknown }).versions;
  if (!Array.isArray(versions)) return null;
  const full =
    versions.find((v) => (v as { percentage?: number }).percentage === 100) ?? versions[0];
  const id = (full as { version_id?: unknown } | undefined)?.version_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** True when `GET /builds/builds?version_ids=<v>` says build `buildUuid` produced a version. */
export function versionFromBuild(body: unknown, buildUuid: string): boolean {
  const builds = (body as { result?: { builds?: unknown } } | null)?.result?.builds;
  if (!builds || typeof builds !== "object") return false;
  const values = Array.isArray(builds) ? builds : Object.values(builds);
  return values.some((b) => (b as { build_uuid?: unknown } | null)?.build_uuid === buildUuid);
}

/* ------------------------------------------------------------------------------------------ */
/* Smoke check                                                                                 */
/* ------------------------------------------------------------------------------------------ */

export type Probe = {
  name: string;
  path: string;
  /** `json`: 200 and a JSON body. `exists`: 2xx, 401, or 403; a 404 means the route is absent. */
  expect: "ok" | "json" | "exists";
  headers?: Record<string, string>;
};

export type ProbeResult = {
  probe: Probe;
  /** Null when no response arrived (network error or timeout). */
  status: number | null;
  ok: boolean;
  detail: string;
};

/** The Acme fixture names the caller in `x-user-id` (fixtures/acme-shop/src/identity.ts). */
const FIXTURE_USER = { "x-user-id": "alice" };

/** Placeholder segments (`:id`) cannot be probed without fixture data; static GET routes only. */
const probeable = (route: string) => /^GET \/\S*$/.test(route) && !route.includes(":");

/**
 * Release smoke probes: the app shell, the existing products API, and up to two GET routes the
 * Change added (from its contract Evidence), which must exist after the deployment.
 */
export function smokeProbes(addedRoutes: readonly string[], injectedPath?: string): Probe[] {
  const probes: Probe[] = [
    { name: "app shell", path: "/", expect: "ok" },
    { name: "products API", path: "/api/products", expect: "json", headers: FIXTURE_USER },
  ];
  for (const route of addedRoutes.filter(probeable).slice(0, 2)) {
    const path = route.slice("GET ".length);
    probes.push({ name: `feature ${route}`, path, expect: "exists", headers: FIXTURE_USER });
  }
  if (injectedPath) {
    probes.push({
      name: `injected probe GET ${injectedPath}`,
      path: injectedPath,
      expect: "exists",
    });
  }
  return probes;
}

/** Judges one response against its probe. */
export function judgeProbe(probe: Probe, status: number, body: string): ProbeResult {
  if (probe.expect === "exists") {
    const ok = (status >= 200 && status < 300) || status === 401 || status === 403;
    return {
      probe,
      status,
      ok,
      detail: ok ? `${status}` : status === 404 ? "404: route not deployed" : `${status}`,
    };
  }
  if (status !== 200) return { probe, status, ok: false, detail: `${status}, expected 200` };
  if (probe.expect === "json") {
    try {
      JSON.parse(body);
    } catch {
      return { probe, status, ok: false, detail: "200, but the body is not JSON" };
    }
  }
  return { probe, status, ok: true, detail: "200" };
}

export type SmokeOutcome = {
  status: EvidenceStatus;
  coverage: EvidenceCoverage;
  summary: string;
};

/**
 * Section 34.4.1 for releases: a probe with no response is a gap, never a pass. Only a smoke
 * check where every probe answered as expected passes. Any wrong answer fails.
 */
export function classifySmoke(results: readonly ProbeResult[]): SmokeOutcome {
  if (results.length === 0) {
    return { status: "error", coverage: "not_checked", summary: "No smoke probe ran." };
  }
  const failed = results.filter((r) => r.status !== null && !r.ok);
  const missing = results.filter((r) => r.status === null);
  const line = (r: ProbeResult) => `${r.probe.name} (${r.detail})`;
  if (failed.length > 0) {
    return {
      status: "fail",
      coverage: "checked_supported",
      summary: `Smoke failed: ${failed.map(line).join("; ")}`.slice(0, 500),
    };
  }
  if (missing.length > 0) {
    return {
      status: "error",
      coverage: "not_checked",
      summary: `No response: ${missing.map(line).join("; ")}. A gap, never a pass.`.slice(0, 500),
    };
  }
  return {
    status: "pass",
    coverage: "checked_supported",
    summary: `Smoke passed: ${results.map(line).join("; ")}`.slice(0, 500),
  };
}

/** Runs the probes against the release URL. A probe with no response has status null. */
export async function runProbes(url: string, probes: readonly Probe[]): Promise<ProbeResult[]> {
  const base = url.replace(/\/+$/, "");
  return Promise.all(
    probes.map(async (probe): Promise<ProbeResult> => {
      try {
        const response = await fetch(`${base}${probe.path}`, {
          headers: { "cache-control": "no-cache", ...probe.headers },
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        return judgeProbe(probe, response.status, await response.text());
      } catch (error) {
        return { probe, status: null, ok: false, detail: String(error).slice(0, 120) };
      }
    }),
  );
}

/** Only a supported pass marks a release deployed. */
export const smokePassed = (outcome: SmokeOutcome) =>
  outcome.status === "pass" && outcome.coverage === "checked_supported";

/**
 * Routes the Change added, from the contract Evidence output (`bun run contract` on the base,
 * then on the Candidate; verification-workflow.ts runContract). Empty when either table is absent.
 */
export function addedRoutesFromContract(output: string): string[] {
  const marker = "\n$ bun run contract\n";
  const at = output.lastIndexOf(marker);
  if (at < 0) return [];
  const table = (text: string) => {
    for (const raw of text.split(/\r?\n/).reverse()) {
      const line = raw.trim();
      if (!line.startsWith("{")) continue;
      try {
        const routes = (JSON.parse(line) as { routes?: unknown }).routes;
        if (Array.isArray(routes) && routes.every((r) => typeof r === "string")) {
          return routes as string[];
        }
      } catch {
        // Not JSON: keep looking.
      }
    }
    return null;
  };
  const base = table(output.slice(0, at));
  const candidate = table(output.slice(at + marker.length));
  if (!base || !candidate) return [];
  const before = new Set(base);
  return candidate.filter((r) => !before.has(r)).sort();
}
