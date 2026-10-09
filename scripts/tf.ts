/**
 * Runs Terraform for one root with credentials loaded from the macOS Keychain.
 * Usage: bun run tf <bootstrap|global|dev|prod> <terraform args...>
 * Values already set in the environment take precedence (for CI later).
 */
import { resolve } from "node:path";
import { $ } from "bun";

const roots: Record<string, string> = {
  bootstrap: "bootstrap",
  global: "envs/global",
  dev: "envs/dev",
  prod: "envs/prod",
};

const keychain: Record<string, string> = {
  CLOUDFLARE_API_TOKEN: "rhumbatron-cloudflare-api-token",
  TF_VAR_account_id: "rhumbatron-cloudflare-account-id",
  AWS_ACCESS_KEY_ID: "rhumbatron-r2-state-access-key-id",
  AWS_SECRET_ACCESS_KEY: "rhumbatron-r2-state-secret-access-key",
};

// Per-root secrets, loaded only for the root that needs them.
const rootKeychain: Record<string, Record<string, string>> = {
  dev: {
    TF_VAR_clerk_secret_key: "rhumbatron-clerk-secret-key-dev",
    TF_VAR_k2_consumer_token: "rhumbatron-k2-consumer-token-dev",
    TF_VAR_openrouter_api_key: "rhumbatron-openrouter-api-key",
    TF_VAR_vertex_service_account: "rhumbatron-vertex-sa-dev",
  },
  // ADR 0017. The OpenRouter key is shared with dev; the others are prod-only.
  prod: {
    TF_VAR_clerk_secret_key: "rhumbatron-clerk-secret-key-prod",
    TF_VAR_clerk_publishable_key: "rhumbatron-clerk-publishable-key-prod",
    TF_VAR_k2_consumer_token: "rhumbatron-k2-consumer-token-prod",
    TF_VAR_openrouter_api_key: "rhumbatron-openrouter-api-key",
    TF_VAR_vertex_service_account: "rhumbatron-vertex-sa-prod",
  },
};

const [root, ...args] = process.argv.slice(2);
const dir = root ? roots[root] : undefined;
if (!dir || args.length === 0) {
  console.error(`Usage: bun run tf <${Object.keys(roots).join("|")}> <terraform args...>`);
  process.exit(2);
}
if (args.includes("-auto-approve")) {
  console.error("Refusing -auto-approve. Read the plan, then apply the saved plan file.");
  process.exit(2);
}

const env: Record<string, string> = { ...process.env } as Record<string, string>;
for (const [name, service] of Object.entries({
  ...keychain,
  ...(rootKeychain[root ?? ""] ?? {}),
})) {
  if (env[name]) continue;
  const value = (
    await $`security find-generic-password -s ${service} -w`.quiet().nothrow().text()
  ).trim();
  if (!value) {
    console.error(`Missing ${name}: no Keychain item "${service}". See ADR 0004.`);
    process.exit(1);
  }
  env[name] = value;
}

const cwd = resolve(import.meta.dir, "../infrastructure/terraform", dir);
const result = await $`terraform ${args}`.cwd(cwd).env(env).nothrow();
process.exit(result.exitCode);
