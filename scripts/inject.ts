/**
 * Failure injection through the public dev API (AGENTS.md Phase 13, sections 42 and 60).
 * Usage: bun run inject [--sandbox] [--only=<fault-id>,...] [--keep]
 *
 * Runs as the Clerk smoke user (CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID from the Keychain, the
 * same credentials as `bun run smoke:dev`). No fault calls a model: every Change skips the planner.
 * Default faults write about 15 D1 rows and use no Sandbox. `--sandbox` adds the Candidate faults:
 * one Acme Shop Candidate verification in the Sandbox (a few minutes of the 10 h monthly cap,
 * ADR 0011), concurrent approvals and promotions, and a stale Candidate. Every Project this run
 * creates is archived at the end (its Artifacts repos are deleted) unless `--keep` is given.
 *
 * Faults that need internal hooks (K2 outage, Sandbox loss, model timeout, poison command,
 * expired Claim) are proven by critical tests; see docs/demo/failure-injection.md.
 * `--only=release-smoke-failure` (P13-12) fails the smoke check of the demo Project's latest
 * deployed release on purpose; it never runs by default.
 */
import { connect } from "./inject/client.ts";
import { type Check, Context, faults } from "./inject/faults.ts";

const api = "https://api-dev.rhumbatron.com";
const args = process.argv.slice(2);
const withSandbox = args.includes("--sandbox");
const keep = args.includes("--keep");
const only = args
  .find((a) => a.startsWith("--only="))
  ?.slice("--only=".length)
  .split(",")
  .filter(Boolean);

const unknown = only?.filter((id) => !faults.some((f) => f.id === id)) ?? [];
if (unknown.length > 0) {
  console.error(
    `Unknown fault: ${unknown.join(", ")}. Known: ${faults.map((f) => f.id).join(", ")}`,
  );
  process.exit(2);
}

const secretKey = process.env.CLERK_SECRET_KEY;
const userId = process.env.CLERK_SMOKE_USER_ID;
if (!secretKey || !userId) {
  console.error("CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID are required (use `bun run inject`).");
  process.exit(2);
}

// `explicit` faults change shared demo state, so they run only when named with --only.
const selected = faults.filter((f) =>
  only ? only.includes(f.id) : !f.explicit && (withSandbox || !f.sandbox),
);
const session = await connect(api, secretKey, userId);
const ctx = new Context(session, Date.now().toString(36));

type Outcome = { id: string; title: string; ok: boolean };
const outcomes: Outcome[] = [];

for (const fault of selected) {
  console.log(`\n${fault.id}  ${fault.title}  (section ${fault.sections})`);
  let checks: Check[];
  try {
    checks = await fault.run(ctx);
  } catch (error) {
    // A fault that could not run is a failure, never a skipped pass.
    checks = [{ name: "fault ran", ok: false, detail: String(error).slice(0, 200) }];
  }
  for (const c of checks) {
    console.log(`  ${c.ok ? "pass" : "FAIL"}  ${c.name}${c.detail ? `  ${c.detail}` : ""}`);
  }
  outcomes.push({ id: fault.id, title: fault.title, ok: checks.every((c) => c.ok) });
}

if (!keep) {
  for (const id of ctx.created) {
    const reply = await session.request("DELETE", `/v1/projects/${id}`);
    console.log(
      `\ncleanup  ${id}  ${reply.status === 200 ? "archived" : `not archived (${reply.status})`}`,
    );
  }
}
await session.close();

console.log("\nFault                      Result");
for (const o of outcomes) console.log(`${o.id.padEnd(26)} ${o.ok ? "pass" : "FAIL"}`);
const failed = outcomes.filter((o) => !o.ok).length;
console.log(`\n${outcomes.length - failed}/${outcomes.length} faults recovered as designed.`);
if (!withSandbox && !only) {
  console.log("Candidate faults skipped: run `bun run inject --sandbox` to include them.");
}
process.exit(failed === 0 ? 0 : 1);
