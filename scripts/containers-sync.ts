/**
 * Temporary Containers adapter (ADR 0011). Provider 5.27 has no container application resource,
 * and cloudflare_workers_script has no `containers` attribute. Invoked only by
 * terraform_data.sandbox_container, after the agents Worker upload. Read-before-write, never deletes.
 *
 * Step 1 (attach): a Durable Object class runs a container only when the deployed Worker version
 * lists it in upload metadata `containers: [{ name, class_name }]`, as the Wrangler deploy flow sends.
 * The list is per version and is not inherited, so every Terraform script upload drops it. If the
 * deployed version lacks it, re-upload the same bundle with the live settings, every binding as
 * `inherit`, and the `containers` entry. No migrations are sent, so the migration tag is unchanged.
 *
 * Step 2 (application): create the container application bound by Durable Object namespace ID
 * (as Wrangler does), or patch size, image, and instance cap when they drift.
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
  configuration: { image: string; instance_type?: string };
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

async function deployedVersionsAttached(): Promise<boolean> {
  const { deployments } = await cfApi<{ deployments: Deployment[] }>(
    token,
    `${scriptUrl}/deployments`,
  );
  const versions = deployments[0]?.versions ?? [];
  if (versions.length === 0) throw new Error(`${config.script_name} has no deployment`);
  for (const { version_id } of versions) {
    const version = await cfApi<Version>(token, `${scriptUrl}/versions/${version_id}`);
    const containers = version.resources.script_runtime.containers ?? [];
    if (!containers.some((c) => c.class_name === config.class_name)) return false;
  }
  return true;
}

// Step 1: attach the container to the Durable Object class on the deployed version.
if (await deployedVersionsAttached()) {
  console.log(`${config.script_name}: ${config.class_name} is container-enabled`);
} else {
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
  await cfApiForm(token, `${scriptUrl}?bindings_inherit=strict&excludeScript=true`, form);
  if (!(await deployedVersionsAttached())) {
    throw new Error(`${config.script_name}: upload did not attach ${config.class_name}`);
  }
  console.log(`${config.script_name}: attached container to ${config.class_name}`);
}

// Step 2: the container application, bound by Durable Object namespace ID.
const namespaces = await cfApi<Namespace[]>(
  token,
  `${account}/workers/durable_objects/namespaces?per_page=1000`,
);
const namespace = namespaces.find(
  (n) => n.script === config.script_name && n.class === config.class_name,
);
if (!namespace) throw new Error(`No namespace for ${config.script_name}/${config.class_name}`);

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
  existing.configuration.instance_type !== config.instance_type
) {
  await cfApi(token, `${base}/${existing.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      max_instances: config.max_instances,
      configuration: { image: config.image, instance_type: config.instance_type },
    }),
  });
  console.log(`updated container application ${config.name}`);
} else {
  console.log(`container application ${config.name} is up to date`);
}
