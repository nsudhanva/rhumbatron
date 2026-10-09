/**
 * Temporary Containers adapter (ADR 0011). Provider 5.27 has no container application resource,
 * and cloudflare_workers_script has no `containers` attribute. Invoked only by
 * terraform_data.sandbox_container, after the agents Worker upload. Read-before-write, never deletes.
 *
 * Step 1 (attach): a Durable Object class runs a container only when the deployed Worker version
 * lists it in upload metadata `containers: [{ name, class_name }]`, as the Wrangler deploy flow sends.
 * The list is per version and is not inherited, so every Terraform script upload drops it. This
 * adapter runs only when its triggers change, which is when Terraform re-uploaded the script, so it
 * always re-uploads the same bundle with the live settings, every binding as `inherit`, and the
 * `containers` entry. It does not trust a pre-upload read: the deployments list can lag an upload
 * by seconds and report the previous (attached) version. No migrations are sent, so the migration
 * tag is unchanged. It then waits until the new version is the deployed one.
 *
 * Step 2 (application): create the container application bound by Durable Object namespace ID
 * (as Wrangler does), or patch size, image, and instance cap when they drift, then start a rollout.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertInvokedByTerraform, cfApi, cfApiForm, requiredEnv } from "./lib/cloudflare-api.ts";

assertInvokedByTerraform("containers-sync");

type AppConfig = {
  name: string;
  image: string;
  instance_type: string;
  max_instances: number;
  class_name: string;
  script_name: string;
};
type ScriptConfig = {
  main_module: string;
  modules: { name: string; content_file: string; content_type: string }[];
};
type App = {
  id: string;
  name: string;
  max_instances: number;
  configuration: {
    image: string;
    instance_type?: string;
    vcpu?: number;
    memory_mib?: number;
    disk?: { size_mb?: number };
  };
  durable_objects?: { namespace_id?: string };
};
type Deployment = { versions: { version_id: string; percentage: number }[] };
type Version = {
  id: string;
  resources: { script_runtime: { containers?: { name?: string; class_name: string }[] } };
};
type Settings = {
  bindings: { type: string; name: string }[];
  compatibility_date?: string;
  compatibility_flags?: string[];
  observability?: unknown;
  logpush?: boolean;
  usage_model?: string;
};
type Namespace = { id: string; class: string; script: string };

const token = requiredEnv("CLOUDFLARE_API_TOKEN");
const accountId = requiredEnv("CONTAINERS_ACCOUNT_ID");
const repoRoot = requiredEnv("CONTAINERS_REPO_ROOT");
const config = JSON.parse(requiredEnv("CONTAINERS_CONFIG")) as AppConfig;
const script = JSON.parse(requiredEnv("CONTAINERS_SCRIPT")) as ScriptConfig;
const account = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const scriptUrl = `${account}/workers/scripts/${config.script_name}`;

async function attached(versionId: string): Promise<boolean> {
  const { deployments } = await cfApi<{ deployments: Deployment[] }>(
    token,
    `${scriptUrl}/deployments`,
  );
  const versions = deployments[0]?.versions ?? [];
  if (!versions.some((v) => v.version_id === versionId && v.percentage === 100)) return false;
  const version = await cfApi<Version>(token, `${scriptUrl}/versions/${versionId}`);
  const containers = version.resources.script_runtime.containers ?? [];
  return containers.some((c) => c.class_name === config.class_name);
}

// Step 1: re-upload the deployed bundle with the container attached to the Durable Object class.
// Reads can lag Terraform's upload by seconds, so settle first. Lag stays loud: a removed binding
// fails the strict inherit, and a missing new binding shows as drift on the next plan.
await Bun.sleep(10_000);
const settings = await cfApi<Settings>(token, `${scriptUrl}/settings`);
const metadata = {
  main_module: script.main_module,
  compatibility_date: settings.compatibility_date,
  compatibility_flags: settings.compatibility_flags,
  // Same bindings as the version Terraform deployed, secrets included, without reading them.
  bindings: settings.bindings.map(({ name }) => ({ type: "inherit", name })),
  containers: [{ name: config.name, class_name: config.class_name }],
  ...(settings.observability !== undefined && { observability: settings.observability }),
  ...(settings.logpush !== undefined && { logpush: settings.logpush }),
  ...(settings.usage_model !== undefined && { usage_model: settings.usage_model }),
};
const form = new FormData();
form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
for (const m of script.modules) {
  const content = readFileSync(resolve(repoRoot, m.content_file));
  form.set(m.name, new File([content], m.name, { type: m.content_type }));
}
// strict: fail instead of silently dropping a binding that cannot be inherited.
const upload = await cfApiForm<{ deployment_id: string }>(
  token,
  `${scriptUrl}?bindings_inherit=strict&excludeScript=true`,
  form,
);
// Wrangler reads the new version ID from `deployment_id` (hyphenless UUID).
const versionId = upload.deployment_id.replace(
  /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
  "$1-$2-$3-$4-$5",
);
let ok = false;
for (let attempt = 0; attempt < 12 && !ok; attempt++) {
  ok = await attached(versionId);
  if (!ok) await Bun.sleep(5_000);
}
if (!ok)
  throw new Error(`${config.script_name}: version ${versionId} is not deployed with a container`);
console.log(
  `${config.script_name}: version ${versionId} attaches a container to ${config.class_name}`,
);

// Step 2: the container application, bound by Durable Object namespace ID.
const namespaces = await cfApi<Namespace[]>(
  token,
  `${account}/workers/durable_objects/namespaces?per_page=1000`,
);
const namespace = namespaces.find(
  (n) => n.script === config.script_name && n.class === config.class_name,
);
if (!namespace) throw new Error(`No namespace for ${config.script_name}/${config.class_name}`);

// The API returns sizes, not the instance type name. Same table as Wrangler (instanceTypes).
const instanceTypes: Record<string, [number, number, number]> = {
  lite: [0.0625, 256, 2000],
  basic: [0.25, 1024, 4000],
  "standard-1": [0.5, 4096, 8000],
  "standard-2": [1, 6144, 12000],
  "standard-3": [2, 8192, 16000],
  "standard-4": [4, 12288, 20000],
};
function instanceType(c: App["configuration"]): string | undefined {
  if (c.instance_type) return c.instance_type;
  return Object.entries(instanceTypes).find(
    ([, [vcpu, mem, disk]]) => c.vcpu === vcpu && c.memory_mib === mem && c.disk?.size_mb === disk,
  )?.[0];
}

const base = `${account}/containers/applications`;
const apps = await cfApi<App[]>(token, base);
const existing = apps.find((a) => a.name === config.name);

if (!existing) {
  await cfApi(token, base, {
    method: "POST",
    body: JSON.stringify({
      name: config.name,
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
  console.log(`created container application ${config.name}`);
} else if (existing.durable_objects?.namespace_id !== namespace.id) {
  throw new Error(
    `${config.name} is bound to another Durable Object namespace. Stop and resolve it (ADR 0011).`,
  );
} else if (
  existing.max_instances !== config.max_instances ||
  existing.configuration.image !== config.image ||
  instanceType(existing.configuration) !== config.instance_type
) {
  const configuration = { image: config.image, instance_type: config.instance_type };
  await cfApi(token, `${base}/${existing.id}`, {
    method: "PATCH",
    body: JSON.stringify({ max_instances: config.max_instances, configuration }),
  });
  // Running instances keep the old image and size until a rollout replaces them (as Wrangler does).
  if (
    existing.configuration.image !== config.image ||
    instanceType(existing.configuration) !== config.instance_type
  ) {
    await cfApi(token, `${base}/${existing.id}/rollouts`, {
      method: "POST",
      body: JSON.stringify({
        description: "Progressive update",
        strategy: "rolling",
        kind: "full_auto",
        step_percentage: 100,
        target_configuration: configuration,
      }),
    });
  }
  console.log(`updated container application ${config.name}`);
} else {
  console.log(`container application ${config.name} is up to date`);
}
