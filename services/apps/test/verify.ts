/**
 * End-to-end check of the apps host against the stub core (services/apps/README.md):
 * build an app through RPC, point a host at it, serve it, use DATA, prove it has no network,
 * probe, run AppChecker, wipe data.
 *
 *   INTERNAL_TOKEN=... bun services/apps/test/verify.ts
 */
import { createAppsClient } from "../client.ts";

const token = process.env.INTERNAL_TOKEN ?? "";
const appsUrl = process.env.APPS_URL ?? "http://127.0.0.1:8788";
const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8789";
const coreUrl = process.env.CORE_URL ?? "http://127.0.0.1:8790";
const domain = process.env.APPS_DOMAIN ?? "rhumbatron.localhost";

const projectId = "proj_verify";
const commit = "a".repeat(40);
const treeSha = "b".repeat(40);
const label = "demo";

const appSource = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/net") {
      try {
        const r = await fetch("https://example.com/");
        return Response.json({ blocked: false, status: r.status });
      } catch (error) {
        return Response.json({ blocked: true, error: String(error) });
      }
    }
    if (url.pathname === "/data") {
      const n = Number((await env.DATA.get("hits")) ?? "0") + 1;
      await env.DATA.put("hits", String(n));
      return Response.json({ hits: n });
    }
    return new Response("hello from " + url.hostname);
  },
};
`;
const files: Record<string, string> = {
  "wrangler.jsonc": `{ "name": "demo", "main": "src/index.js", "compatibility_date": "2026-10-08" }`,
  "src/index.js": appSource,
  "src/index.test.ts": `import { expect, test } from "bun:test";
test("adds", () => { expect(1 + 1).toBe(2); });
`,
};

const apps = createAppsClient({ url: rpcUrl, token });
let failures = 0;
function check(name: string, ok: boolean, detail: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(detail).slice(0, 300)}`);
}

async function core(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(`${coreUrl}${path}`, { ...init, headers });
}
async function sql(statement: string, params: unknown[] = []) {
  const response = await core("/internal/d1", {
    method: "POST",
    body: JSON.stringify({ statements: [{ sql: statement, params }], batch: false }),
  });
  if (!response.ok) throw new Error(`d1 ${response.status} ${await response.text()}`);
  return response.json();
}
const visit = (path: string) =>
  fetch(`${appsUrl}${path}`, { headers: { host: `${label}.${domain}` } });

// 1. RPC auth: no token, no call.
const denied = await fetch(`${rpcUrl}/rpc/AppBuilder/wipeData`, { method: "POST", body: "[[]]" });
check("rpc rejects a missing token", denied.status === 401, denied.status);

// 2. Build through RPC (bundle and assets land in the core's R2).
const built = await apps.build({
  projectId,
  commit,
  treeSha,
  channel: "production",
  files: Object.entries(files).map(([path, text]) => ({ path, text })),
});
check("build", built.ok, built);
if (!built.ok) process.exit(1);

// 3. Point the production host at the bundle (the integration service does this in core).
const now = new Date().toISOString();
await sql(
  `INSERT OR REPLACE INTO app_deployments (project_id, slug, channel, commit_sha, generation, bundle_key, status, failure_reason, created_at, updated_at)
   VALUES (?, ?, 'production', ?, 1, ?, 'ready', NULL, ?, ?)`,
  [projectId, label, commit, built.bundleKey, now, now],
);

// 4. Serve it.
const home = await visit("/");
const homeText = await home.text();
check("serve app", home.status === 200 && homeText.includes("hello from"), homeText);

// 5. DATA binding (AppDataDO on local disk).
const first = (await (await visit("/data")).json()) as { hits: number };
const second = (await (await visit("/data")).json()) as { hits: number };
check("data store", second.hits === first.hits + 1, { first, second });

// 6. No network for app code.
const net = (await (await visit("/net")).json()) as { blocked: boolean };
check("app cannot fetch example.com", net.blocked === true, net);

// 7. Probe through the router (release smoke path).
const probe = await apps.probe({ label, path: "/" });
check("probe", probe.status === 200, probe);

// 8. AppChecker: source comes from R2 (code manifest plus blobs), as storeTreeCode writes it.
const entries = [];
for (const [path, text] of Object.entries(files)) {
  const blob = new Bun.CryptoHasher("sha1").update(text).digest("hex");
  await core(`/internal/r2/object/${encodeURIComponent(`source/${projectId}/blobs/${blob}`)}`, {
    method: "PUT",
    headers: { "x-r2-meta": "{}" },
    body: text,
  });
  entries.push({ path, blob, size: new TextEncoder().encode(text).length, stored: true });
}
await core(
  `/internal/r2/object/${encodeURIComponent(`source/${projectId}/${treeSha}/code.json`)}`,
  {
    method: "PUT",
    headers: { "x-r2-meta": "{}" },
    body: JSON.stringify({ commit, treeSha, entries, complete: true }),
  },
);
for (const kind of ["build", "unit"] as const) {
  const result = await apps.check({ projectId, treeSha, kind });
  check(`check ${kind}`, result.status === "pass", {
    status: result.status,
    summary: result.summary,
  });
}

// 9. AppData through RPC, then wipe the production store. (A wiped store is not served again: the
// callers wipe removed apps and expired previews only.)
const stored = await fetch(`${rpcUrl}/rpc/AppData/get`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "x-rpc-props": JSON.stringify({ storeName: projectId }),
  },
  body: JSON.stringify(["hits"]),
});
check("AppData.get over rpc", (await stored.json()) === String(second.hits), second.hits);
const wiped = await apps.wipeData([projectId, "not a store name"]);
check("wipeData", wiped.wiped === 1, wiped);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
