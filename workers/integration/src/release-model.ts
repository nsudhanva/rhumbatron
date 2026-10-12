import type { EvidenceCoverage, EvidenceStatus, ReleaseStatus } from "@rhumbatron/protocol";

/**
 * Release decisions (ADR 0020). Pure: the ReleaseWorkflow
 * feeds these functions what the apps router and ProjectRootDO returned. Deterministic. No model call decides whether a release is deployed.
 */

/** One release per Project and Canonical Generation. Also the Workflow instance ID. */
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
 * A release is for exactly one generation. When canonical has
 * moved past it before the release finished, the newer generation's release owns the app.
 */
export function supersededBy(releaseGeneration: number, canonicalGeneration: number) {
  return canonicalGeneration > releaseGeneration;
}

/* ------------------------------------------------------------------------------------------ */
/* Smoke check                                                                                 */
/* ------------------------------------------------------------------------------------------ */

export type Probe = {
  name: string;
  path: string;
  /**
   * `page`: 2xx or 3xx, and not an apps router status page. `exists`: 2xx, 401, or 403; a 404
   * means the route is absent.
   */
  expect: "page" | "exists";
  headers?: Record<string, string>;
};

export type ProbeResult = {
  probe: Probe;
  /** Null when no response arrived (network error or timeout). */
  status: number | null;
  ok: boolean;
  detail: string;
};

/** Route probes taken from the app's own route table, at most. */
const MAX_ROUTE_PROBES = 3;

/** Placeholder segments (`:id`) cannot be probed without fixture data; static GET routes only. */
const probeable = (route: string) => /^GET \/\S*$/.test(route) && !route.includes(":");

/**
 * Release smoke probes for any app: the home page, then up to `MAX_ROUTE_PROBES` static GET routes
 * from the app's own route table (the contract Evidence of the released Candidate), the routes the
 * Change added first. Without a route table, only the home page.
 */
export function smokeProbes(
  table: {
    routes?: readonly string[] | null;
    added?: readonly string[];
  } = {},
  injectedPath?: string,
): Probe[] {
  const probes: Probe[] = [{ name: "home page", path: "/", expect: "page" }];
  const seen = new Set(probes.map((p) => p.path));
  let routeProbes = 0;
  for (const route of [...(table.added ?? []), ...(table.routes ?? [])]) {
    if (routeProbes >= MAX_ROUTE_PROBES) break;
    if (!probeable(route)) continue;
    const path = route.slice("GET ".length);
    if (seen.has(path)) continue;
    seen.add(path);
    routeProbes++;
    probes.push({ name: `route ${route}`, path, expect: "exists" });
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

/**
 * Titles of the apps router's own status pages (workers/apps/src/pages.ts). A home page that is
 * one of them means the app is not serving: "Nothing built yet" answers 200, so the status code
 * alone cannot tell.
 */
const ROUTER_PAGE_TITLES = [
  "No app here",
  "App removed",
  "Building",
  "Nothing built yet",
  "Build failed",
  "App limit reached",
  "App error",
];
const ROUTER_PAGE_FOOTER = '<a href="https://rhumbatron.com">Rhumbatron</a>';

/** The router's status page title when `body` is one, else null. */
function routerPageTitle(body: string): string | null {
  if (!body.includes(ROUTER_PAGE_FOOTER)) return null;
  return ROUTER_PAGE_TITLES.find((title) => body.includes(`<title>${title}</title>`)) ?? null;
}

/** Judges one response against its probe. */
export function judgeProbe(probe: Probe, status: number, body: string): ProbeResult {
  if (probe.expect === "page") {
    if (status < 200 || status >= 400) {
      return { probe, status, ok: false, detail: `${status}, expected 2xx or 3xx` };
    }
    const title = routerPageTitle(body);
    return title
      ? { probe, status, ok: false, detail: `${status}, but the router answered "${title}"` }
      : { probe, status, ok: true, detail: `${status}` };
  }
  if (probe.expect === "exists") {
    const ok = (status >= 200 && status < 300) || status === 401 || status === 403;
    return {
      probe,
      status,
      ok,
      detail: ok ? `${status}` : status === 404 ? "404: route not deployed" : `${status}`,
    };
  }
  return { probe, status, ok: true, detail: `${status}` };
}

export type SmokeOutcome = {
  status: EvidenceStatus;
  coverage: EvidenceCoverage;
  summary: string;
};

/**
 * A release probe with no response is a gap, never a pass. Only a smoke
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

/** Only a supported pass marks a release deployed. */
export const smokePassed = (outcome: SmokeOutcome) =>
  outcome.status === "pass" && outcome.coverage === "checked_supported";

/** The base and Candidate route tables in contract Evidence output; null when one is absent. */
function contractTables(output: string) {
  // Both check runners record the same route table with different command markers.
  const marker = ["\n$ bun run contract\n", "\n$ [dynamic-worker] contract\n"].sort(
    (a, b) => output.lastIndexOf(b) - output.lastIndexOf(a),
  )[0] as string;
  const at = output.lastIndexOf(marker);
  if (at < 0) return { base: null, candidate: null };
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
  return { base: table(output.slice(0, at)), candidate: table(output.slice(at + marker.length)) };
}

/**
 * Routes the Change added, from the contract Evidence output (`bun run contract` on the base,
 * then on the Candidate; verification-workflow.ts runContract). Empty when either table is absent.
 */
export function addedRoutesFromContract(output: string): string[] {
  const { base, candidate } = contractTables(output);
  if (!base || !candidate) return [];
  const before = new Set(base);
  return candidate.filter((r) => !before.has(r)).sort();
}

/**
 * The Candidate's whole route table from the same output, sorted. Null when it is absent; a first
 * Change on an empty repository has no base table but still has this one.
 */
export function routesFromContract(output: string): string[] | null {
  const { candidate } = contractTables(output);
  return candidate ? [...candidate].sort() : null;
}
