/**
 * Wishlist design-conflict demo (AGENTS.md sections 4, 32.4, 54, 55; P9-08). No model calls.
 *
 * Remote (dev): on the `acme-shop-demo` Project, creates the Wishlist Change without the planner,
 * publishes fixture designs A and B as ChangeSets, shows the detected conflict, creates Candidate A
 * (design A only) and Candidate B (design B only), waits for verification, and prints the
 * comparison. Expected: A rejected on p95, B verified and waiting for human approval.
 *   bun run demo:wishlist                    new Change
 *   bun run demo:wishlist --change chg_...   resume an existing Change
 *
 * Local: applies each design to a temporary copy of fixtures/acme-shop and runs the same
 * Verification Plan commands and classifiers the Candidate workflow uses (no Browser Run).
 *   bun run demo:wishlist --local [a|b|both]
 */
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { applyDesign } from "../fixtures/wishlist/apply.ts";
import { CHANGE_PLAN, WISHLIST_GOAL, type WishlistDesign } from "../fixtures/wishlist/manifest.ts";
import { buildVerificationPlan } from "../packages/evidence/src/plan.ts";
import type { EvidenceRecord, VerificationCheck } from "../packages/protocol/src/index.ts";
import {
  type CheckOutcome,
  type CheckRun,
  classifyCheck,
  classifyContract,
  DEFAULT_POLICY,
  verificationTouches,
} from "../workers/integration/src/candidate-composer.ts";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : (args[i + 1] ?? "");
};
const designsArg = (value: string | undefined): WishlistDesign[] =>
  value === "a" || value === "b" ? [value] : ["a", "b"];

// ---------------------------------------------------------------------------------------------
// Local mode
// ---------------------------------------------------------------------------------------------

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".DS_Store") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

async function run(cwd: string, command: string, env: Record<string, string> = {}) {
  const started = performance.now();
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output =
    stdout && stderr && !stdout.endsWith("\n") ? `${stdout}\n${stderr}` : stdout + stderr;
  const result: CheckRun = { exitCode, output, timedOut: false };
  return { ...result, seconds: (performance.now() - started) / 1000 };
}

async function localDesign(design: WishlistDesign) {
  const base = join(root, "fixtures/acme-shop");
  const fixtureDir = join(root, "fixtures/wishlist");
  const fixture: Record<string, string> = {};
  for (const path of await walk(fixtureDir)) {
    fixture[relative(fixtureDir, path)] = await readFile(path, "utf8");
  }
  const dir = await mkdtemp(join(tmpdir(), `wishlist-${design}-`));
  await cp(base, dir, { recursive: true, filter: (src) => !src.includes("node_modules") });
  await symlink(join(base, "node_modules"), join(dir, "node_modules"));
  const changes = applyDesign(design, fixture, (path) => {
    try {
      return readFileSync(join(dir, path), "utf8");
    } catch {
      return null;
    }
  });
  for (const [path, content] of Object.entries(changes.files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }

  const plan = buildVerificationPlan({
    candidateId: `local_${design}`,
    riskTier: CHANGE_PLAN.riskTier,
    policy: DEFAULT_POLICY,
    ...verificationTouches({
      goal: WISHLIST_GOAL,
      invariants: CHANGE_PLAN.invariants,
      acceptanceCriteria: CHANGE_PLAN.acceptanceCriteria,
      files: Object.keys(changes.files),
      touchesAuthorization: true,
    }),
  });
  console.log(`\nDesign ${design.toUpperCase()} in ${dir}`);
  console.log(`  files: ${changes.added.length} added, ${changes.modified.length} modified`);
  const results: { check: VerificationCheck; outcome: CheckOutcome; seconds: number }[] = [];
  for (const check of plan.checks) {
    if (check.kind === "contract") {
      const candidate = await run(dir, "bun run contract");
      const baseRun = await run(dir, "bun run contract", { CONTRACT_ROOT: base });
      results.push({
        check,
        outcome: classifyContract(baseRun, candidate, changes.intent.expectedContractChanges),
        seconds: candidate.seconds + baseRun.seconds,
      });
    } else if (check.command) {
      const result = await run(dir, check.command);
      results.push({ check, outcome: classifyCheck(check, result), seconds: result.seconds });
    } else {
      results.push({
        check,
        outcome: {
          status: "skipped",
          coverage: "not_checked",
          summary: "Not run locally (Browser Run runs in the Candidate workflow).",
        },
        seconds: 0,
      });
    }
    const last = results.at(-1);
    if (last) {
      console.log(
        `  ${last.check.checkId.padEnd(26)} ${last.outcome.status.padEnd(7)} ${last.seconds.toFixed(1).padStart(5)} s  ${last.outcome.summary}`,
      );
    }
  }
  if (!args.includes("--keep")) await rm(dir, { recursive: true, force: true });
  const p95 = results.find((r) => r.check.kind === "performance")?.outcome.metrics?.p95Ms;
  // Browser Run only runs in the Candidate workflow; locally it is a known gap, not a result.
  const failed = results.filter(
    (r) => r.check.required && r.check.kind !== "browser" && r.outcome.status !== "pass",
  );
  return { design, p95, failed: failed.map((r) => r.check.checkId) };
}

async function local() {
  const summary = [];
  for (const design of designsArg(flag("--local"))) summary.push(await localDesign(design));
  console.log("\nSummary");
  for (const s of summary) {
    console.log(
      `  ${s.design.toUpperCase()}: p95 ${s.p95?.toFixed(3) ?? "?"} ms; ${s.failed.length === 0 ? "every required check passes (browser not run locally)" : `not passing: ${s.failed.join(", ")}`}`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Remote mode (dev)
// ---------------------------------------------------------------------------------------------

const API = "https://api-dev.rhumbatron.com";
const FINAL = new Set(["verified", "rejected", "stale", "promoted"]);

type Candidate = {
  id: string;
  status: string;
  statusReason: string | null;
  changeSetIds: string[];
  approvalRequired: boolean;
  gate: { promotable: boolean; gaps: { checkId: string; reason: string }[]; p95Ms?: number } | null;
};
type FixtureView = {
  changeSets: { design: "a" | "b"; changeSetId: string; status: string | null; title: string }[];
};
type Conflict = {
  resource: string;
  state: string;
  recommendedAction: string;
  signals: { severity: string; kind: string; detail: string }[];
  intents: { title: string; summary: string; assumptions: string[] }[];
};

async function remote() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const userId = process.env.CLERK_SMOKE_USER_ID;
  if (!secretKey || !userId) {
    console.error("CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID are required (see package.json).");
    process.exit(2);
  }
  async function clerk<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`https://api.clerk.com/v1${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Clerk ${path} returned ${response.status}`);
    return (await response.json()) as T;
  }
  const session = await clerk<{ id: string }>("/sessions", { user_id: userId });
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { jwt } = await clerk<{ jwt: string }>(`/sessions/${session.id}/tokens`, {});
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`${method} ${path} returned ${response.status}: ${text.slice(0, 300)}`);
    return (JSON.parse(text) as { data: T }).data;
  }
  async function until<T>(what: string, ms: number, every: number, probe: () => Promise<T | null>) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value !== null) return value;
      await Bun.sleep(every);
    }
    throw new Error(`timed out waiting for ${what}; resume with --change`);
  }

  try {
    let changeId = flag("--change");
    if (!changeId) {
      const projects = await call<{ id: string; slug: string }[]>("GET", "/v1/projects");
      const project = projects.find((p) => p.slug === "acme-shop-demo");
      if (!project) throw new Error("No acme-shop-demo Project: run `bun run demo:project` first.");
      const canonical = await call<{ canonical: { artifactRef: string; generation: number } }>(
        "GET",
        `/v1/projects/${project.id}`,
      );
      if (canonical.canonical.artifactRef === "unassigned")
        throw new Error("Project has no source yet.");
      const change = await call<{ id: string }>("POST", `/v1/projects/${project.id}/changes`, {
        goal: WISHLIST_GOAL,
        startPlanning: false,
        clientRequestId: `demo-wishlist-${Date.now()}`,
      });
      changeId = change.id;
      console.log(`project   ${project.id} (S${canonical.canonical.generation})`);
      console.log(`change    ${changeId}`);
    }

    // 1. Two fixture agents publish competing designs as ChangeSets.
    await call("POST", `/v1/changes/${changeId}/fixture-changesets`, { design: "both" });
    const fixture = await until("fixture ChangeSets", 4 * 60_000, 5_000, async () => {
      const view = await call<FixtureView>("GET", `/v1/changes/${changeId}/fixture-changesets`);
      return view.changeSets.every((c) => c.status) ? view : null;
    });
    const ids = Object.fromEntries(fixture.changeSets.map((c) => [c.design, c.changeSetId]));
    for (const c of fixture.changeSets)
      console.log(`changeset ${c.design.toUpperCase()} ${c.changeSetId}  ${c.title}`);

    // 2. The deterministic detector flags the semantic conflict.
    const conflicts = await call<Conflict[]>("GET", `/v1/changes/${changeId}/conflicts`);
    for (const c of conflicts) {
      console.log(`\nconflict  ${c.resource}: ${c.state}, ${c.recommendedAction}`);
      for (const s of c.signals.filter((s) => s.severity === "hard"))
        console.log(`  hard: ${s.detail}`);
      for (const side of c.intents) console.log(`  ${side.title}: ${side.assumptions.join(" ")}`);
    }

    // 3. One Candidate per design; executable Evidence decides.
    const existing = await call<Candidate[]>("GET", `/v1/changes/${changeId}/candidates`);
    const candidates: Record<string, string> = {};
    for (const design of ["a", "b"] as const) {
      const id = ids[design];
      if (!id) throw new Error(`no ChangeSet for design ${design}`);
      const found = existing.find((c) => c.changeSetIds.length === 1 && c.changeSetIds[0] === id);
      candidates[design] =
        found?.id ??
        (
          await call<Candidate>("POST", `/v1/changes/${changeId}/candidates`, {
            changeSetIds: [id],
          })
        ).id;
      console.log(`candidate ${design.toUpperCase()} ${candidates[design]}`);
    }
    console.log("\nwaiting for verification (Sandbox compose and checks take a few minutes)…");
    const done = await until("verification", 30 * 60_000, 15_000, async () => {
      const list = await call<Candidate[]>("GET", `/v1/changes/${changeId}/candidates`);
      const mine = list.filter((c) => Object.values(candidates).includes(c.id));
      return mine.length === 2 && mine.every((c) => FINAL.has(c.status)) ? mine : null;
    });

    // 4. Comparison.
    const evidence: Record<string, EvidenceRecord[]> = {};
    for (const [design, id] of Object.entries(candidates)) {
      evidence[design] = await call<EvidenceRecord[]>("GET", `/v1/candidates/${id}/evidence`);
    }
    const checks = [...new Set(Object.values(evidence).flatMap((e) => e.map((r) => r.checkId)))];
    console.log(`\n${"check".padEnd(26)} ${"A".padEnd(10)} B`);
    for (const check of checks) {
      const cell = (d: string) => {
        const r = evidence[d]?.find((e) => e.checkId === check);
        return r
          ? `${r.status}${r.coverage === "checked_supported" ? "" : `(${r.coverage})`}`
          : "-";
      };
      console.log(`${check.padEnd(26)} ${cell("a").padEnd(10)} ${cell("b")}`);
    }
    for (const [design, id] of Object.entries(candidates)) {
      const c = done.find((x) => x.id === id);
      const perf = evidence[design]?.find((e) => e.checkId === "performance");
      console.log(
        `\nCandidate ${design.toUpperCase()} ${c?.status}${c?.statusReason ? `: ${c.statusReason}` : ""}`,
      );
      if (perf) console.log(`  performance: ${perf.summary}`);
      if (c?.status === "verified" && c.approvalRequired) {
        console.log("  waiting for human approval (authorization-sensitive), then promotion");
      }
    }
    const a = done.find((c) => c.id === candidates.a);
    const b = done.find((c) => c.id === candidates.b);
    const aPerf = evidence.a?.find((e) => e.checkId === "performance");
    const expected =
      a?.status === "rejected" && aPerf?.status === "fail" && b?.status === "verified";
    console.log(
      expected ? "\nExpected outcome: A rejected on p95, B verified." : "\nUnexpected outcome.",
    );
    if (!expected) process.exitCode = 1;
  } finally {
    await clerk(`/sessions/${session.id}/revoke`, {});
  }
}

if (args.includes("--local")) await local();
else await remote();
