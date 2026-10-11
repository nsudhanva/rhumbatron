/**
 * Enforces AGENTS.md project policy that generic linters cannot express.
 * Fails when a tracked file can mutate remote Cloudflare state outside Terraform,
 * or when a credential literal appears in Terraform source.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
// These files contain the forbidden strings only to detect and reject them.
const exempt = new Set(["scripts/check-guardrails.ts", "scripts/tf.ts"]);

type Rule = {
  id: string;
  files: RegExp;
  pattern: RegExp;
  message: string;
};

const automationFiles =
  /(^|\/)(package\.json|lefthook\.yml|turbo\.json)$|\.(ya?ml|sh)$|^scripts\/.*\.ts$/;

const rules: Rule[] = [
  {
    id: "no-wrangler-deploy",
    files: automationFiles,
    pattern: /wrangler\s+(deploy|publish|versions\s+(upload|deploy)|rollback)(?![^\n"']*--dry-run)/,
    message: "Remote deploys go through Terraform. Only `wrangler deploy --dry-run` is allowed.",
  },
  {
    id: "no-wrangler-remote-mutation",
    files: automationFiles,
    pattern:
      /wrangler\s+(secret\s+(put|delete|bulk)|(d1|r2|kv|queues|vectorize|hyperdrive|workflows)\b[^\n]*\b(create|delete|put|update)\b|d1\s+(execute|migrations\s+apply)\b[^\n]*--remote)/,
    message: "Remote Cloudflare changes must go through Terraform.",
  },
  {
    id: "no-terraform-auto-approve",
    files: automationFiles,
    pattern: /-auto-approve/,
    message: "Read the plan. Do not use -auto-approve.",
  },
  {
    id: "no-terraform-credential-literal",
    files: /\.(tf|tfvars|hcl)$/,
    pattern: /^\s*(api_token|api_key|access_key|secret_key|token)\s*=\s*"[^"$]+"/m,
    message: "Read credentials from the environment, not from Terraform source.",
  },
  {
    id: "no-direct-cloudflare-api-write",
    files: automationFiles,
    pattern: /curl[^\n]*-X\s*(POST|PUT|PATCH|DELETE)[^\n]*api\.cloudflare\.com/,
    message: "Do not write to the Cloudflare API directly. Use Terraform.",
  },
];

const tracked = (await $`git ls-files --cached --others --exclude-standard`.cwd(root).text())
  .split("\n")
  .filter((f) => f && !exempt.has(f));

const failures: string[] = [];

// Local secret files must never be tracked, even when force-added past .gitignore.
const secretFile =
  /(^|\/)(\.env(\..+)?|\.dev\.vars(\..+)?|terraform\.tfvars|backend\.hcl|.*\.tfstate(\..+)?)$/;
const allowedExample = /\.example(\.hcl)?$|\.env\.example$|\.dev\.vars\.example$/;
for (const file of tracked) {
  if (secretFile.test(file) && !allowedExample.test(file)) {
    failures.push(`${file} [no-tracked-secret-file] Local secret files must not be committed.`);
  }
}
for (const file of tracked) {
  const applicable = rules.filter((r) => r.files.test(file));
  if (applicable.length === 0) continue;
  let text: string;
  try {
    text = await readFile(resolve(root, file), "utf8");
  } catch {
    continue;
  }
  for (const rule of applicable) {
    const match = rule.pattern.exec(text);
    if (match) {
      const line = text.slice(0, match.index).split("\n").length;
      failures.push(`${file}:${line} [${rule.id}] ${rule.message}`);
    }
  }
}

// Cloudflare resource names follow rhumbatron-<component>-<env> (docs/operations/naming.md).
// Outputs and variables are skipped because binding names and descriptions live there.
const tfResourceFile = /^infrastructure\/terraform\/.*\.tf$/;
const nameAttribute = /^\s*(name|queue_name|title|bucket_name)\s*=\s*"([^"]+)"/gm;
const literalSegment = "[a-z0-9-]";
const interpolation = "\\$\\{[^}]+\\}";
const validName = new RegExp(
  `^rhumbatron-(${literalSegment}|${interpolation})+(-(prod|global)|${interpolation})$`,
);
for (const file of tracked) {
  if (!tfResourceFile.test(file) || /(outputs|variables)\.tf$/.test(file)) continue;
  const text = await readFile(resolve(root, file), "utf8");
  for (const match of text.matchAll(nameAttribute)) {
    const value = match[2] ?? "";
    if (!validName.test(value)) {
      const line = text.slice(0, match.index).split("\n").length;
      failures.push(
        `${file}:${line} [resource-naming] "${value}" must follow rhumbatron-<component>-<prod|global>.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  console.error(`\n${failures.length} guardrail violation(s).`);
  process.exit(1);
}
console.log(`Guardrails passed (${tracked.length} files scanned).`);
