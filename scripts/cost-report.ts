/**
 * Read-only cost and leftover-resource report for Rhumbatron (AGENTS.md sections 7 and 44, rule 50).
 * Usage: bun run cost:report [--alerts-only]
 * Uses the read-only monitor token (Keychain `rhumbatron-cloudflare-monitor-token`). Never writes.
 * Exit code 1 when any line is ALERT, so a loop can watch it.
 */

import {
  AGENT_DAILY_CALL_CAP,
  OPENROUTER_DAILY_CALL_CAP,
  USAGE_COUNTER,
  vertexSpendLimit,
} from "@rhumbatron/model-router";

const token = process.env.CLOUDFLARE_MONITOR_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const d1Token = process.env.CLOUDFLARE_D1_TOKEN;
if (!token || !accountId) {
  console.error(
    "CLOUDFLARE_MONITOR_TOKEN and CLOUDFLARE_ACCOUNT_ID are required (see package.json).",
  );
  process.exit(2);
}
const alertsOnly = process.argv.includes("--alerts-only");
const env = "dev";
/**
 * Dev's caps from envs/dev/main.tf (ADR 0017): `VERTEX_SPEND_LIMIT_USD` and
 * `SANDBOX_MONTHLY_SECONDS`. Prod has its own (Vertex $10, Sandbox 5 h).
 */
const DEV_VERTEX_CAP = vertexSpendLimit("40");
const DEV_SANDBOX_HOURS = 18_000 / 3600;
const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;

type Level = "OK" | "WARN" | "ALERT" | "ERROR";
const lines: { level: Level; area: string; detail: string }[] = [];
const report = (level: Level, area: string, detail: string) => lines.push({ level, area, detail });

/** OK below 60 %, WARN below `alertAt` (85 %), ALERT above (of a free or included limit). */
function usage(area: string, used: number, limit: number, unit: string, alertAt = 0.85) {
  const ratio = limit > 0 ? used / limit : 0;
  const level: Level = ratio >= alertAt ? "ALERT" : ratio >= 0.6 ? "WARN" : "OK";
  report(
    level,
    area,
    `${Math.round(used).toLocaleString()} / ${limit.toLocaleString()} ${unit} (${Math.round(ratio * 100)}%)`,
  );
}

async function get<T>(path: string, auth = token): Promise<T> {
  const response = await fetch(`${api}${path}`, { headers: { authorization: `Bearer ${auth}` } });
  const body = (await response.json()) as {
    success: boolean;
    result: T;
    errors?: { message: string }[];
  };
  if (!response.ok || !body.success)
    throw new Error(body.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`);
  return body.result;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { data?: T; errors?: { message: string }[] | null };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  if (!body.data) throw new Error("no data");
  return body.data;
}

async function section(area: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (error) {
    report("ERROR", area, String(error instanceof Error ? error.message : error).slice(0, 160));
  }
}

const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const until = new Date().toISOString();
const today = until.slice(0, 10);

await section("containers", async () => {
  type App = {
    name: string;
    max_instances?: number;
    health?: { instances?: { active?: number; starting?: number } };
  };
  const apps = await get<App[]>("/containers/applications");
  if (apps.length === 0) report("OK", "containers", "no container applications");
  for (const app of apps) {
    const active = (app.health?.instances?.active ?? 0) + (app.health?.instances?.starting ?? 0);
    const ours = app.name.startsWith("rhumbatron-");
    report(
      !ours ? "WARN" : active > 1 ? "ALERT" : "OK",
      "containers",
      `${app.name}: ${active} running, max ${app.max_instances ?? "?"}${ours ? "" : " (not Rhumbatron: shares the allowance)"}`,
    );
  }
});

await section("workers", async () => {
  const expected = [
    "api",
    "web",
    "coordinator",
    "event-router",
    "integration",
    "agents",
    "sandbox",
    "indexer",
    // Release target: Terraform owns the Worker; Workers Builds owns its versions (ADR 0014).
    "acme-shop",
  ].map((c) => `rhumbatron-${c}-${env}`);
  const scripts = await get<{ id: string }[]>("/workers/scripts");
  const ours = scripts.map((s) => s.id).filter((id) => id.startsWith("rhumbatron-"));
  const orphans = ours.filter((id) => !expected.includes(id) && !id.endsWith("-prod"));
  report(
    orphans.length ? "WARN" : "OK",
    "workers",
    `${ours.length} Rhumbatron Workers${orphans.length ? `; not in Terraform: ${orphans.join(", ")}` : ""}`,
  );
  const data = await graphql<{
    viewer: {
      accounts: {
        workersInvocationsAdaptive: {
          sum: { requests: number; cpuTimeUs: number };
          dimensions: { scriptName: string };
        }[];
      }[];
    };
  }>(
    `query ($account: string!, $since: Time!, $until: Time!) { viewer { accounts(filter: {accountTag: $account}) {
      workersInvocationsAdaptive(limit: 100, filter: {datetime_geq: $since, datetime_leq: $until}) {
        sum { requests cpuTimeUs } dimensions { scriptName } } } } }`,
    { account: accountId, since, until },
  );
  const rows = data.viewer.accounts[0]?.workersInvocationsAdaptive ?? [];
  const mine = rows.filter((r) => r.dimensions.scriptName.startsWith("rhumbatron-"));
  usage(
    "workers requests 24h",
    mine.reduce((n, r) => n + r.sum.requests, 0),
    100_000,
    "requests (Free daily)",
  );
  const top = mine.sort((a, b) => b.sum.requests - a.sum.requests).slice(0, 3);
  report(
    "OK",
    "workers top",
    top
      .map((r) => `${r.dimensions.scriptName.replace("rhumbatron-", "")}=${r.sum.requests}`)
      .join(" "),
  );
});

await section("durable objects", async () => {
  const data = await graphql<{
    viewer: {
      accounts: { durableObjectsInvocationsAdaptiveGroups: { sum: { requests: number } }[] }[];
    };
  }>(
    `query ($account: string!, $since: Time!, $until: Time!) { viewer { accounts(filter: {accountTag: $account}) {
      durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: {datetime_geq: $since, datetime_leq: $until}) { sum { requests } } } } }`,
    { account: accountId, since, until },
  );
  const requests = (data.viewer.accounts[0]?.durableObjectsInvocationsAdaptiveGroups ?? []).reduce(
    (n, r) => n + r.sum.requests,
    0,
  );
  usage("durable object requests 24h (account)", requests, 100_000, "requests (Free daily)");
});

await section("workflows", async () => {
  for (const name of ["change-workflow", "candidate-verification"]) {
    for (const status of ["running", "queued", "waiting"]) {
      const result = await get<unknown[]>(
        `/workflows/rhumbatron-${name}-${env}/instances?status=${status}&per_page=50`,
      );
      if (result.length > 0)
        report(
          status === "running" ? "WARN" : "OK",
          "workflows",
          `${result.length} ${status} ${name} instances`,
        );
    }
  }
  report("OK", "workflows", "checked running, queued, waiting");
});

await section("d1", async () => {
  const dbs = await get<{ uuid: string; name: string; file_size?: number }[]>("/d1/database");
  for (const db of dbs.filter((d) => d.name.startsWith("rhumbatron-"))) {
    usage(`d1 ${db.name} size`, (db.file_size ?? 0) / 1e6, 500, "MB (Free per database)");
  }
});

await section("r2", async () => {
  const data = await graphql<{
    viewer: {
      accounts: {
        r2StorageAdaptiveGroups: {
          max: { payloadSize: number; objectCount: number };
          dimensions: { bucketName: string };
        }[];
      }[];
    };
  }>(
    `query ($account: string!, $since: Time!, $until: Time!) { viewer { accounts(filter: {accountTag: $account}) {
      r2StorageAdaptiveGroups(limit: 100, filter: {datetime_geq: $since, datetime_leq: $until}) {
        max { payloadSize objectCount } dimensions { bucketName } } } } }`,
    { account: accountId, since, until },
  );
  const rows = (data.viewer.accounts[0]?.r2StorageAdaptiveGroups ?? []).filter((r) =>
    r.dimensions.bucketName.startsWith("rhumbatron-"),
  );
  const bytes = rows.reduce((n, r) => n + r.max.payloadSize, 0);
  usage("r2 storage (Rhumbatron)", bytes / 1e9, 10, "GB (included)");
});

/** Read-only D1 query on the control database with the D1 token. */
async function d1Query<T>(sql: string, params: unknown[] = [], database = env): Promise<T[]> {
  if (!d1Token) throw new Error("set CLOUDFLARE_D1_TOKEN");
  const dbs = await get<{ uuid: string; name: string }[]>("/d1/database", d1Token);
  const db = dbs.find((d) => d.name === `rhumbatron-control-${database}`);
  if (!db) throw new Error("control database not found");
  const response = await fetch(`${api}/d1/database/${db.uuid}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${d1Token}`, "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const body = (await response.json()) as { result?: { results: T[] }[] };
  return body.result?.[0]?.results ?? [];
}

await section("artifacts", async () => {
  type Repo = { name: string };
  const repos = await get<Repo[]>(
    `/artifacts/namespaces/rhumbatron-projects-${env}/repos?limit=200`,
  );
  const workspaces = repos.filter((r) => r.name.startsWith("ws-")).length;
  const candidates = repos.filter((r) => r.name.startsWith("cand-")).length;
  const canonical = repos.filter((r) => r.name.startsWith("proj_")).length;
  report(
    workspaces + candidates > 50 ? "WARN" : "OK",
    "artifacts",
    `${repos.length} repos: ${canonical} canonical, ${workspaces} workspace forks, ${candidates} candidate forks (daily sweep after retention)`,
  );
});

await section("projects", async () => {
  // Cleanup runs seconds after an archive; a day later anything left is stuck (DLQ or errors).
  const [row] = await d1Query<{ active: number; pending: number; stuck: number; cleaned: number }>(
    `SELECT COALESCE(SUM(status = 'active'), 0) AS active,
            COALESCE(SUM(status = 'archived' AND cleaned_at IS NULL), 0) AS pending,
            COALESCE(SUM(status = 'archived' AND cleaned_at IS NULL AND archived_at < ?), 0) AS stuck,
            COALESCE(SUM(cleaned_at IS NOT NULL), 0) AS cleaned
     FROM projects`,
    [since],
  );
  if (!row) throw new Error("no result");
  report(
    row.stuck > 0 ? "WARN" : "OK",
    "projects",
    `${row.active} active, ${row.pending} archived awaiting cleanup${row.stuck ? ` (${row.stuck} for over a day)` : ""}, ${row.cleaned} cleaned`,
  );
});

await section("ai gateway", async () => {
  const response = await fetch(
    `${api}/ai-gateway/gateways/rhumbatron-models-${env}/logs?per_page=1`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  const body = (await response.json()) as {
    result_info?: { total_count?: number };
    success: boolean;
  };
  if (!body.success) throw new Error("logs not readable");
  usage("ai gateway stored logs", body.result_info?.total_count ?? 0, 10_000, "logs (gateway cap)");
});

await section("rhumbatron meters", async () => {
  if (!d1Token) {
    report("WARN", "rhumbatron meters", "set CLOUDFLARE_D1_TOKEN to read usage_counters");
    return;
  }
  const rows = await d1Query<{ day: string; counter: string; count: number }>(
    "SELECT day, counter, count FROM usage_counters WHERE day IN (?, ?)",
    [today, today.slice(0, 7)],
  );
  const value = (counter: string) => rows.find((r) => r.counter === counter)?.count ?? 0;
  usage(
    "agent model calls today",
    value(USAGE_COUNTER.agentCalls),
    AGENT_DAILY_CALL_CAP,
    "calls, all providers (daily cap)",
  );
  // Reaching the OpenRouter cap is expected: runs overflow to Gemini, capped by the gateway (ADR 0016).
  const openrouterUsedUp =
    value(USAGE_COUNTER.openrouterExhausted) > 0 ||
    value(USAGE_COUNTER.openrouterCalls) >= OPENROUTER_DAILY_CALL_CAP;
  report(
    openrouterUsedUp ? "WARN" : "OK",
    "openrouter today",
    `${value(USAGE_COUNTER.openrouterCalls)} / ${OPENROUTER_DAILY_CALL_CAP} calls${
      openrouterUsedUp
        ? `; used up, new runs use Gemini (Vertex, $${DEV_VERTEX_CAP.usd} per ${DEV_VERTEX_CAP.days} days cap)`
        : ""
    }${value(USAGE_COUNTER.vertexSpendLimited) > 0 ? "; Vertex spend cap reached today" : ""}`,
  );
  usage("clef-flash calls today", value("clef-flash"), 200, "calls (daily cap)");
  usage(
    "sandbox this month",
    value("sandbox-seconds") / 3600,
    DEV_SANDBOX_HOURS,
    "hours (HOM-192 cap, dev share)",
  );
});

/**
 * Live apps (prod only, ADR 0020, P16-21). Caps: `APP_BUILDS_PER_DAY` in
 * workers/integration/src/app-release.ts (enforced before every build), and the Workers Paid
 * allowances for Dynamic Workers (1,000 created per month), requests, and CPU (shared).
 */
const APP_BUILDS_PER_DAY = 60;
const DYNAMIC_WORKERS_PER_MONTH = 1_000;

await section("apps", async () => {
  const data = await graphql<{
    viewer: {
      accounts: {
        workersInvocationsAdaptive: { sum: { requests: number; cpuTimeUs: number } }[];
      }[];
    };
  }>(
    `query ($account: string!, $since: Time!, $until: Time!, $script: string!) { viewer { accounts(filter: {accountTag: $account}) {
      workersInvocationsAdaptive(limit: 10, filter: {datetime_geq: $since, datetime_leq: $until, scriptName: $script}) {
        sum { requests cpuTimeUs } } } } }`,
    { account: accountId, since, until, script: "rhumbatron-apps-prod" },
  );
  const rows = data.viewer.accounts[0]?.workersInvocationsAdaptive ?? [];
  const requests = rows.reduce((n, r) => n + r.sum.requests, 0);
  const cpuMs = rows.reduce((n, r) => n + r.sum.cpuTimeUs, 0) / 1000;
  // Monthly allowances, as a daily share (10 M requests and 30 M CPU-ms per month, shared).
  usage("apps router requests 24h", requests, 333_000, "requests (daily share of 10 M/month)", 0.8);
  usage("apps router cpu 24h", cpuMs, 1_000_000, "ms (daily share of 30 M/month)", 0.8);
  if (!d1Token) {
    report("WARN", "apps", "set CLOUDFLARE_D1_TOKEN to read app builds and bundles");
    return;
  }
  const [builds] = await d1Query<{ count: number }>(
    "SELECT count FROM usage_counters WHERE day = ? AND counter = 'app-builds'",
    [today],
    "prod",
  );
  // Live app meters alert at 80 % (docs/plans/phase-16-live-apps.md P16-21).
  usage("app builds today", builds?.count ?? 0, APP_BUILDS_PER_DAY, "builds (daily cap)", 0.8);
  const [bundles] = await d1Query<{ versions: number; bytes: number; previews: number }>(
    `SELECT COUNT(*) AS versions, COALESCE(SUM(bytes), 0) AS bytes,
            COALESCE(SUM(preview), 0) AS previews
     FROM (SELECT bundle_key, MAX(bundle_bytes) AS bytes,
                  MAX(bundle_key LIKE 'app-previews/%') AS preview
           FROM app_deployments WHERE status = 'ready' AND bundle_key IS NOT NULL
           GROUP BY bundle_key)`,
    [],
    "prod",
  );
  // A loaded version is one Dynamic Worker per day, so ready bundles bound the daily count.
  usage(
    "app versions that can load",
    (bundles?.versions ?? 0) * 30,
    DYNAMIC_WORKERS_PER_MONTH,
    `Dynamic Workers per month at most (${bundles?.versions ?? 0} bundles, ${bundles?.previews ?? 0} previews)`,
    0.8,
  );
  usage(
    "app bundle bytes in r2",
    (bundles?.bytes ?? 0) / 1e6,
    1_000,
    "MB (of the 10 GB R2 allowance)",
  );
});

const order: Level[] = ["ALERT", "ERROR", "WARN", "OK"];
const shown = lines
  .filter((l) => !alertsOnly || l.level === "ALERT" || l.level === "ERROR")
  .sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
for (const l of shown) console.log(`${l.level.padEnd(5)}  ${l.area.padEnd(38)} ${l.detail}`);
if (!alertsOnly) console.log(`\n${new Date().toISOString()} · ${lines.length} checks`);
process.exit(lines.some((l) => l.level === "ALERT") ? 1 : 0);
