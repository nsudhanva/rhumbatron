/**
 * Writes `.env` for `docker compose`. Git ignores the file.
 * - Keeps every value that `.env` already has, so a second run changes nothing.
 * - Reads the Clerk development keys from `apps/web/.env.local`.
 * - Reads the Anthropic key from the environment, or from the macOS Keychain item
 *   `rhumbatron-anthropic-api-key` when one exists.
 * - Generates random internal tokens and object-store keys.
 * It never prints a secret.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..");
const target = join(root, ".env");

function parse(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) out[match[1] as string] = (match[2] as string).replace(/^["']|["']$/g, "");
  }
  return out;
}

async function keychain(service: string): Promise<string> {
  if (process.platform !== "darwin") return "";
  return (await $`security find-generic-password -s ${service} -w`.quiet().nothrow().text()).trim();
}

const random = (bytes = 32) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");

const current = parse(target);
const web = parse(join(root, "apps/web/.env.local"));

const wanted: Record<string, () => Promise<string> | string> = {
  CLERK_PUBLISHABLE_KEY: () =>
    process.env.CLERK_PUBLISHABLE_KEY ?? web.VITE_CLERK_PUBLISHABLE_KEY ?? "",
  CLERK_SECRET_KEY: async () =>
    process.env.CLERK_SECRET_KEY ??
    web.CLERK_SECRET_KEY ??
    (await keychain("rhumbatron-clerk-secret-key-dev")),
  ANTHROPIC_API_KEY: async () =>
    process.env.ANTHROPIC_API_KEY ?? (await keychain("rhumbatron-anthropic-api-key")),
  ANTHROPIC_WORKSPACE_ID: async () =>
    process.env.ANTHROPIC_WORKSPACE_ID ?? (await keychain("rhumbatron-anthropic-workspace-id")),
  PLATFORM_ADMIN_USER_IDS: () => "[]",
  INTERNAL_TOKEN: () => random(),
  GIT_ADMIN_TOKEN: () => random(),
  GIT_TOKEN_SECRET: () => random(),
  SANDBOXD_TOKEN: () => random(),
  S3_ACCESS_KEY: () => `rhumbatron${random(6)}`,
  S3_SECRET_KEY: () => random(),
};

const next: Record<string, string> = { ...current };
const missing: string[] = [];
for (const [name, make] of Object.entries(wanted)) {
  if (next[name]) continue;
  next[name] = await make();
  if (!next[name]) missing.push(name);
}

const body = [
  "# Local stack settings for docker compose. Written by scripts/local-env.ts. Do not commit.",
  ...Object.entries(next).map(([k, v]) => `${k}=${v}`),
  "",
].join("\n");
writeFileSync(target, body, { mode: 0o600 });
console.log(`Wrote .env with ${Object.keys(next).length} values.`);
if (missing.length) console.log(`Set these by hand in .env: ${missing.join(", ")}`);
