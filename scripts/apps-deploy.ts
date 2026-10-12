/**
 * Temporary apps Worker adapter (ADR 0020). Provider 5.27 has no
 * `worker_loader` binding type, so `cloudflare_worker_version` cannot carry the Worker Loader
 * binding. Invoked only by terraform_data.apps_worker (envs/prod).
 *
 * deploy: one full script upload with the code, the bindings from Terraform (including
 *   `{ type: "worker_loader", name: "LOADER" }`, the shape Wrangler 4.149 uploads), and the
 *   AppDataDO migration (`v1` on the first upload, then the live tag as a no-op). Then the
 *   workers.dev subdomain is turned off if it is on: the app router serves only zone routes.
 * destroy: deletes the Worker (and with it the AppDataDO namespace and all app data).
 * Read-before-write throughout; safe to run again. Terraform re-runs it only when the bundle hash
 * or the configuration changes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertInvokedByTerraform, cfApi, cfApiForm, requiredEnv } from "./lib/cloudflare-api.ts";

assertInvokedByTerraform("apps-deploy");

type Config = {
  script_name: string;
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  modules: { name: string; content_file: string; content_type: string }[];
  bindings: Record<string, unknown>[];
  sqlite_classes: string[];
  head_sampling_rate: number;
};

const token = requiredEnv("CLOUDFLARE_API_TOKEN");
const accountId = requiredEnv("APPS_ACCOUNT_ID");
const repoRoot = requiredEnv("APPS_REPO_ROOT");
const mode = requiredEnv("APPS_MODE");
const config = JSON.parse(requiredEnv("APPS_CONFIG")) as Config;
const account = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const scriptUrl = `${account}/workers/scripts/${config.script_name}`;

const scripts = await cfApi<{ id: string; migration_tag?: string }[]>(
  token,
  `${account}/workers/scripts`,
);
const live = scripts.find((s) => s.id === config.script_name);

if (mode === "destroy") {
  if (live) {
    await cfApi(token, `${scriptUrl}?force=true`, { method: "DELETE" });
    console.log(`deleted Worker ${config.script_name}`);
  }
  process.exit(0);
}
if (mode !== "deploy") throw new Error(`unknown APPS_MODE ${mode}`);

const loader = config.bindings.filter((b) => b.type === "worker_loader");
if (loader.length !== 1) throw new Error("the apps Worker needs exactly one worker_loader binding");

// First upload creates the SQLite classes; later uploads keep the live tag (no class change).
const migrations = live?.migration_tag
  ? { old_tag: live.migration_tag, new_tag: live.migration_tag }
  : { new_tag: "v1", new_sqlite_classes: config.sqlite_classes };

const metadata = {
  main_module: config.main_module,
  compatibility_date: config.compatibility_date,
  compatibility_flags: config.compatibility_flags,
  bindings: config.bindings,
  migrations,
  observability: { enabled: true, head_sampling_rate: config.head_sampling_rate },
};
const form = new FormData();
form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
for (const m of config.modules) {
  form.set(
    m.name,
    new File([readFileSync(resolve(repoRoot, m.content_file))], m.name, { type: m.content_type }),
  );
}
await cfApiForm(token, scriptUrl, form);
console.log(`${config.script_name}: uploaded (${live ? "update" : "create"})`);

const subdomain = await cfApi<{ enabled: boolean; previews_enabled?: boolean }>(
  token,
  `${scriptUrl}/subdomain`,
);
if (subdomain.enabled || subdomain.previews_enabled) {
  await cfApi(token, `${scriptUrl}/subdomain`, {
    method: "POST",
    body: JSON.stringify({ enabled: false, previews_enabled: false }),
  });
  console.log(`${config.script_name}: workers.dev subdomain turned off`);
}
