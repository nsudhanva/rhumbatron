/**
 * Billing budget alert adapter (ADR 0019). Provider 5.27 rejects alert_type
 * `billing_budget_alert`, and the Terraform API token has no Notifications permission, so this
 * adapter writes through the `cf` CLI login of the operator who runs `terraform apply`.
 * Invoked only by terraform_data.budget_alerts (sync and destroy). Read-before-write; safe to run
 * again. Owns only policies named `rhumbatron-budget-*`.
 *
 * sync: one policy per spend level. Creates missing levels; replaces drifted ones; deletes levels
 *   that are not configured.
 * destroy: deletes every `rhumbatron-budget-*` policy.
 */
import { $ } from "bun";
import { assertInvokedByTerraform, requiredEnv } from "./lib/cloudflare-api.ts";

assertInvokedByTerraform("budget-alerts");

type Policy = {
  id: string;
  name: string;
  alert_type: string;
  enabled: boolean;
  filters?: { total_spend_dollars?: string[] };
  mechanisms?: { email?: { id: string }[] };
};

const PREFIX = "rhumbatron-budget-";
const mode = requiredEnv("BUDGET_MODE");
// The CLI must use its own login, not the Terraform token that `scripts/tf.ts` exports.
const { CLOUDFLARE_API_TOKEN: _terraformToken, ...cliEnv } = process.env;
$.env(cliEnv);

const ours = ((await $`cf alerting policies list`.quiet().json()) as Policy[]).filter((p) =>
  p.name.startsWith(PREFIX),
);
const remove = (p: Policy) => $`cf alerting policies delete --force ${p.id}`.quiet();

if (mode === "destroy") {
  for (const p of ours) await remove(p);
  console.log(`deleted ${ours.length} budget alert policies`);
  process.exit(0);
}

const emails = requiredEnv("BUDGET_EMAILS")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean)
  .sort();
const levels = (JSON.parse(requiredEnv("BUDGET_LEVELS_USD")) as number[]).map(String);
const nameOf = (usd: string) => `${PREFIX}${usd}-usd`;

const create = (usd: string) =>
  $`cf alerting policies create --body ${JSON.stringify({
    name: nameOf(usd),
    description: `Account spend reached $${usd}. Run bun run cost:report; pause with local.paused.`,
    alert_type: "billing_budget_alert",
    enabled: true,
    filters: { total_spend_dollars: [usd] },
    mechanisms: { email: emails.map((id) => ({ id })) },
  })}`.quiet();

const inSync = (p: Policy, usd: string) =>
  p.alert_type === "billing_budget_alert" &&
  p.enabled &&
  p.filters?.total_spend_dollars?.join() === usd &&
  (p.mechanisms?.email ?? [])
    .map((e) => e.id)
    .sort()
    .join() === emails.join();

for (const usd of levels) {
  // Keep one policy that matches; delete every other policy with this name, including duplicates.
  const named = ours.filter((p) => p.name === nameOf(usd));
  const keep = named.find((p) => inSync(p, usd));
  for (const p of named) if (p !== keep) await remove(p);
  if (keep) {
    console.log(`budget alert at $${usd} is in sync`);
    continue;
  }
  await create(usd);
  console.log(`${named.length > 0 ? "replaced" : "created"} budget alert at $${usd}`);
}

for (const p of ours) {
  if (levels.some((usd) => p.name === nameOf(usd))) continue;
  await remove(p);
  console.log(`deleted stale budget alert ${p.name}`);
}
