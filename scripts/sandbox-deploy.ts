/**
 * Sandbox Worker adapter (ADR 0012). Provider 5.27 cannot attach a container to a
 * Durable Object class, and has no container application resource. Invoked only by
 * terraform_data.sandbox_worker.
 *
 * deploy: one full script upload carrying the code, the SANDBOX binding, the class migration, and
 *   `containers: [{ name, class_name }]`, the shape Wrangler uses on a first deploy. Then the
 *   container application is created (or patched) and bound by Durable Object namespace ID.
 * destroy: deletes the container application, then the Worker (and its namespace).
 * Read-before-write throughout; safe to run again.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertInvokedByTerraform, cfApi, cfApiForm, requiredEnv } from "./lib/cloudflare-api.ts";

assertInvokedByTerraform("sandbox-deploy");

type Config = {
  script_name: string;
  app_name: string;
  class_name: string;
  image: string;
  instance_type: string;
  max_instances: number;
  compatibility_date: string;
  compatibility_flags: string[];
  main_module: string;
  modules: { name: string; content_file: string; content_type: string }[];
};
type App = {
  id: string;
  name: string;
  max_instances: number;
  configuration: { image: string; vcpu?: number; memory_mib?: number; disk?: { size_mb?: number } };
  durable_objects?: { namespace_id?: string };
};

const token = requiredEnv("CLOUDFLARE_API_TOKEN");
const accountId = requiredEnv("SANDBOX_ACCOUNT_ID");
const repoRoot = requiredEnv("SANDBOX_REPO_ROOT");
const mode = requiredEnv("SANDBOX_MODE");
const config = JSON.parse(requiredEnv("SANDBOX_CONFIG")) as Config;
const account = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const scriptUrl = `${account}/workers/scripts/${config.script_name}`;
const appsUrl = `${account}/containers/applications`;

const apps = await cfApi<App[]>(token, appsUrl);
const existingApp = apps.find((a) => a.name === config.app_name);

if (mode === "destroy") {
  if (existingApp) {
    await cfApi(token, `${appsUrl}/${existingApp.id}`, { method: "DELETE" });
    console.log(`deleted container application ${config.app_name}`);
  }
  const scripts = await cfApi<{ id: string }[]>(token, `${account}/workers/scripts`);
  if (scripts.some((s) => s.id === config.script_name)) {
    await cfApi(token, `${scriptUrl}?force=true`, { method: "DELETE" });
    console.log(`deleted Worker ${config.script_name}`);
  }
  process.exit(0);
}

// Migration: create the class on the first upload; afterwards the steady state of the live tag.
const scripts = await cfApi<{ id: string; migration_tag?: string }[]>(
  token,
  `${account}/workers/scripts`,
);
const live = scripts.find((s) => s.id === config.script_name);
const migrations = live?.migration_tag
  ? { old_tag: live.migration_tag, new_tag: live.migration_tag }
  : { new_tag: "v1", new_sqlite_classes: [config.class_name] };

const metadata = {
  main_module: config.main_module,
  compatibility_date: config.compatibility_date,
  compatibility_flags: config.compatibility_flags,
  bindings: [{ type: "durable_object_namespace", name: "SANDBOX", class_name: config.class_name }],
  migrations,
  containers: [{ name: config.app_name, class_name: config.class_name }],
  observability: { enabled: true, head_sampling_rate: 1 },
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
console.log(
  `${config.script_name}: uploaded with ${config.class_name} container (${live ? "update" : "create"})`,
);

const namespaces = await cfApi<{ id: string; class: string; script: string }[]>(
  token,
  `${account}/workers/durable_objects/namespaces?per_page=1000`,
);
const namespace = namespaces.find(
  (n) => n.script === config.script_name && n.class === config.class_name,
);
if (!namespace) throw new Error(`No namespace for ${config.script_name}/${config.class_name}`);

// The API reports sizes, not the type name. Same table as Wrangler.
const sizes: Record<string, [number, number, number]> = {
  lite: [0.0625, 256, 2000],
  basic: [0.25, 1024, 4000],
  "standard-1": [0.5, 4096, 8000],
};
const size = (c: App["configuration"]) =>
  Object.entries(sizes).find(
    ([, [v, m, d]]) => c.vcpu === v && c.memory_mib === m && c.disk?.size_mb === d,
  )?.[0];

if (existingApp && existingApp.durable_objects?.namespace_id !== namespace.id) {
  // A namespace from an earlier Worker: the application must be recreated against the new one.
  await cfApi(token, `${appsUrl}/${existingApp.id}`, { method: "DELETE" });
  console.log(`deleted stale container application ${config.app_name}`);
}
const app = existingApp?.durable_objects?.namespace_id === namespace.id ? existingApp : undefined;
if (!app) {
  await cfApi(token, appsUrl, {
    method: "POST",
    body: JSON.stringify({
      name: config.app_name,
      scheduling_policy: "default",
      instances: 0,
      max_instances: config.max_instances,
      configuration: {
        image: config.image,
        instance_type: config.instance_type,
        observability: { logs: { enabled: true } },
      },
      durable_objects: { namespace_id: namespace.id },
    }),
  });
  console.log(`created container application ${config.app_name}`);
} else if (
  app.max_instances !== config.max_instances ||
  app.configuration.image !== config.image ||
  size(app.configuration) !== config.instance_type
) {
  await cfApi(token, `${appsUrl}/${app.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      max_instances: config.max_instances,
      configuration: { image: config.image, instance_type: config.instance_type },
    }),
  });
  console.log(`updated container application ${config.app_name}`);
} else {
  console.log(`container application ${config.app_name} is up to date`);
}
