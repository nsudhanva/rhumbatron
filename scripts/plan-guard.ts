/**
 * Plan guard for automated deploys. Reads `terraform show -json <plan>` and refuses a plan that
 * deletes stateful Cloudflare resources or Durable Object classes. CI runs it between plan and
 * apply. Set ALLOW_DESTRUCTIVE=true (a manual workflow input) to apply such a plan on purpose.
 *
 * Usage: bun scripts/plan-guard.ts <plan.json> <root name>
 * Writes a Markdown summary to $GITHUB_STEP_SUMMARY when it is set. Prints addresses and actions
 * only, never attribute values.
 */
import { appendFileSync, readFileSync } from "node:fs";

type Change = {
  address: string;
  type: string;
  name: string;
  change: { actions: string[]; before?: unknown; after?: unknown };
};
type Plan = { resource_changes?: Change[] };

/** Deleting or replacing one of these loses data or takes a public endpoint down. */
const STATEFUL_TYPES = new Set([
  "cloudflare_d1_database",
  "cloudflare_r2_bucket",
  "cloudflare_workers_kv_namespace",
  "cloudflare_queue",
  "cloudflare_workflow",
  "cloudflare_worker",
  "cloudflare_workers_script",
  "cloudflare_workers_custom_domain",
  "cloudflare_dns_record",
  "cloudflare_ai_gateway",
]);

/** `terraform_data` adapters whose destroy provisioner deletes a remote resource. */
const isTeardownAdapter = (c: Change) =>
  c.type === "terraform_data" && c.name.endsWith("_teardown");

/** Durable Object classes that a script upload deletes (their storage goes with them). */
function deletedClasses(value: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (key === "deleted_classes" && Array.isArray(child)) out.push(...child.map(String));
        else visit(child);
      }
    }
  };
  visit(value);
  return out;
}

export function guard(plan: Plan): { problems: string[]; rows: string[] } {
  const problems: string[] = [];
  const rows: string[] = [];
  for (const c of plan.resource_changes ?? []) {
    const actions = c.change.actions;
    if (actions.length === 1 && (actions[0] === "no-op" || actions[0] === "read")) continue;
    rows.push(`| \`${c.address}\` | ${actions.join(", ")} |`);
    const deletes = actions.includes("delete");
    if (deletes && (STATEFUL_TYPES.has(c.type) || isTeardownAdapter(c))) {
      problems.push(`${c.address}: ${actions.join("+")} of a stateful resource`);
    }
    if (c.type === "cloudflare_workers_script") {
      const before = new Set(deletedClasses(c.change.before));
      const added = deletedClasses(c.change.after).filter((name) => !before.has(name));
      if (added.length > 0) {
        problems.push(`${c.address}: deletes Durable Object class ${added.join(", ")}`);
      }
    }
  }
  return { problems, rows };
}

if (import.meta.main) {
  const [file, root = "terraform"] = process.argv.slice(2);
  if (!file) {
    console.error("Usage: bun scripts/plan-guard.ts <plan.json> <root name>");
    process.exit(2);
  }
  const plan = JSON.parse(readFileSync(file, "utf8")) as Plan;
  const { problems, rows } = guard(plan);
  const allow = process.env.ALLOW_DESTRUCTIVE === "true";
  const lines = [
    `### Terraform plan: ${root}`,
    "",
    rows.length === 0 ? "No changes." : `| Resource | Actions |\n|---|---|\n${rows.join("\n")}`,
    "",
  ];
  if (problems.length > 0) {
    lines.push(
      allow
        ? "**Destructive changes allowed by ALLOW_DESTRUCTIVE:**"
        : "**Blocked destructive changes:**",
      "",
      ...problems.map((p) => `- ${p}`),
      "",
    );
  }
  const summary = lines.join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (problems.length > 0 && !allow) {
    console.error(
      `plan-guard: ${problems.length} destructive change(s) in ${root}. Run the workflow manually with allow_destructive to apply.`,
    );
    process.exit(1);
  }
}
