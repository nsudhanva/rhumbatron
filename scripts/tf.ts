/**
 * Runs Terraform for one root with credentials loaded from the macOS Keychain.
 * Usage: bun run tf <bootstrap|global|prod> <terraform args...>
 * Values already set in the environment take precedence (for CI later).
 */
import { resolve } from "node:path";
import { $ } from "bun";

const roots: Record<string, string> = {
  bootstrap: "bootstrap",
  global: "envs/global",
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
  // Billing budget alerts (ADR 0019) go to the account owner's address, kept out of source.
  global: {
    TF_VAR_alert_email: "rhumbatron-alert-email",
  },
  // ADR 0017, ADR 0021, ADR 0024. The K2 Consume-only token keeps
  // its original Keychain item name. Clerk is the production instance.
  prod: {
    TF_VAR_clerk_secret_key: "rhumbatron-clerk-secret-key-prod",
    TF_VAR_clerk_publishable_key: "rhumbatron-clerk-publishable-key-prod",
    TF_VAR_k2_consumer_token: "rhumbatron-k2-consumer-token-dev",
    TF_VAR_anthropic_api_key: "rhumbatron-anthropic-api-key",
    TF_VAR_anthropic_workspace_id: "rhumbatron-anthropic-workspace-id",
  },
};

// Public, non-secret values read from a local file when no Keychain item holds them.
const rootFiles: Record<string, Record<string, { file: string; key: string }>> = {};

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

for (const [name, { file, key }] of Object.entries(rootFiles[root ?? ""] ?? {})) {
  if (env[name]) continue;
  const path = resolve(import.meta.dir, "..", file);
  const text = (await Bun.file(path).exists()) ? await Bun.file(path).text() : "";
  const line = text.split("\n").find((l) => l.startsWith(`${key}=`));
  const value = line
    ?.slice(key.length + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!value) {
    console.error(`Missing ${name}: no ${key} in ${file}. See ADR 0017.`);
    process.exit(1);
  }
  env[name] = value;
}

const cwd = resolve(import.meta.dir, "../infrastructure/terraform", dir);
const result = await $`terraform ${args}`.cwd(cwd).env(env).nothrow();
process.exit(result.exitCode);
