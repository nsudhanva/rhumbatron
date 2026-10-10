// Binding drift check (AGENTS.md sections 2.2 and 9). Compares the binding NAMES in every Worker's
// local wrangler.jsonc with the bindings Terraform uploads for that Worker in envs dev and prod.
// Read-only: it never talks to Cloudflare. A name only in wrangler is a local-only binding that
// the remote Worker will not have; a name only in Terraform is a remote-only binding that local
// development does not emulate. Intentional differences live in scripts/binding-drift-allow.json,
// each with a reason. Exit 1 on unexplained drift. A Worker that cannot be checked is a warning.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  balanced,
  hclBindingNames,
  hclBindingsExpr,
  hclBlock,
  hclCapBindingNames,
  parseJsonc,
  stripHclComments,
  wranglerBindingNames,
} from "./lib/binding-drift.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENVS = ["dev", "prod"] as const;
type Env = (typeof ENVS)[number];

type Allow = {
  entries: {
    worker: string;
    envs?: Env[];
    side: "wrangler-only" | "terraform-only";
    names: string[];
    reason: string;
  }[];
  notDeployed: { worker: string; env: Env; reason: string }[];
};
const allow = JSON.parse(
  readFileSync(join(root, "scripts/binding-drift-allow.json"), "utf8"),
) as Allow;
const usedAllow = new Set<unknown>();

const roots = [
  ...["apps/web", "apps/docs"],
  ...readdirSync(join(root, "workers")).map((d) => `workers/${d}`),
].filter((d) => existsSync(join(root, d, "wrangler.jsonc")));

const tfText = (env: Env) =>
  readdirSync(join(root, "infrastructure/terraform/envs", env))
    .filter((f) => f.endsWith(".tf"))
    .map((f) =>
      stripHclComments(readFileSync(join(root, "infrastructure/terraform/envs", env, f), "utf8")),
    )
    .join("\n");

type Terraform = { names: string[] } | { absent: true } | { unchecked: string };

function terraformBindings(dir: string, env: Env): Terraform {
  const text = tfText(env);
  const caps = hclCapBindingNames(text);
  const slug = dir.split("/")[1] as string;

  if (dir === "workers/sandbox") {
    const src = readFileSync(join(root, "scripts/sandbox-deploy.ts"), "utf8");
    const m = /bindings:\s*\[/.exec(src);
    if (!m) return { unchecked: "no static bindings list found in scripts/sandbox-deploy.ts" };
    const list = balanced(src, m.index + m[0].length - 1);
    return {
      names: [...list.matchAll(/\bname:\s*"([A-Za-z0-9_]+)"/g)].map((x) => x[1] as string).sort(),
    };
  }

  let block: string | undefined;
  if (dir === "workers/apps") {
    const m = /^[ \t]*apps_worker\s*=\s*\{/m.exec(text);
    if (!m) return { absent: true };
    block = balanced(text, m.index + m[0].length - 1);
  } else {
    block = hclBlock(text, "module", `${slug.replaceAll("-", "_")}_worker`);
    if (!block) return { absent: true };
  }
  const expr = hclBindingsExpr(block);
  if (!expr) return { unchecked: "no bindings list found in the Terraform block" };
  try {
    return { names: hclBindingNames(expr, caps) };
  } catch (e) {
    return { unchecked: (e as Error).message };
  }
}

let failures = 0;
let warnings = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  DRIFT   ${msg}`);
};
const warn = (msg: string) => {
  warnings++;
  console.log(`  WARN    ${msg}`);
};

for (const dir of roots) {
  const wrangler = wranglerBindingNames(
    parseJsonc(readFileSync(join(root, dir, "wrangler.jsonc"), "utf8")),
  );
  console.log(`${dir} (wrangler: ${wrangler.length} bindings)`);
  for (const env of ENVS) {
    const tf = terraformBindings(dir, env);
    if ("unchecked" in tf) {
      warn(`${env}: NOT CHECKED, ${tf.unchecked}`);
      continue;
    }
    if ("absent" in tf) {
      const nd = allow.notDeployed.find((n) => n.worker === dir && n.env === env);
      if (nd) {
        usedAllow.add(nd);
        console.log(`  ok      ${env}: not deployed (${nd.reason})`);
      } else if (wrangler.length === 0) {
        console.log(`  ok      ${env}: no bindings and no Terraform bindings list`);
      } else {
        warn(
          `${env}: NOT CHECKED, no Terraform Worker found for ${dir}; add a notDeployed allowlist entry if intended`,
        );
      }
      continue;
    }
    const explained = (side: "wrangler-only" | "terraform-only", name: string) => {
      const e = allow.entries.find(
        (a) =>
          a.worker === dir &&
          a.side === side &&
          a.names.includes(name) &&
          (!a.envs || a.envs.includes(env)),
      );
      if (e) usedAllow.add(e);
      return e;
    };
    const onlyWrangler = wrangler.filter((n) => !tf.names.includes(n));
    const onlyTf = tf.names.filter((n) => !wrangler.includes(n));
    let bad = 0;
    for (const n of onlyWrangler) {
      if (explained("wrangler-only", n)) continue;
      bad++;
      fail(`${env}: ${n} only in wrangler.jsonc (missing in Terraform)`);
    }
    for (const n of onlyTf) {
      if (explained("terraform-only", n)) continue;
      bad++;
      fail(`${env}: ${n} only in Terraform (missing in wrangler.jsonc)`);
    }
    if (bad === 0) {
      const allowed = onlyWrangler.length + onlyTf.length;
      console.log(
        `  ok      ${env}: ${tf.names.length} Terraform bindings${allowed ? `, ${allowed} allowlisted` : ""}`,
      );
    }
  }
}

for (const e of [...allow.entries, ...allow.notDeployed]) {
  if (!usedAllow.has(e)) warn(`stale allowlist entry (no longer needed): ${JSON.stringify(e)}`);
}

console.log(
  failures
    ? `\n${failures} unexplained drift(s), ${warnings} warning(s)`
    : `\nno unexplained drift, ${warnings} warning(s)`,
);
process.exit(failures ? 1 : 0);
