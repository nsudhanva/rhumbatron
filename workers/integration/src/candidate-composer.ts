import { type ComposableChangeSet, parseBenchOutput } from "@rhumbatron/evidence";
import {
  ChangeSetIntent,
  type EvidenceCoverage,
  type EvidenceStatus,
  type ProjectPolicy,
  type VerificationCheck,
} from "@rhumbatron/protocol";

/**
 * Deterministic Candidate composition inputs (AGENTS.md sections 33, 34, 53). No I/O here: the
 * workflow loads rows, these functions decide order, verification scope, and check outcomes.
 */

/** Default Project policy (section 53) until Project policies are stored. */
export const DEFAULT_POLICY: ProjectPolicy = {
  version: "policy-1",
  maxCostUsdPerChange: 3,
  maxActiveAgents: 8,
  maxActiveSandboxes: 4,
  maxCandidates: 3,
  humanGateRiskTiers: ["high", "critical"],
  protectedResources: ["cart", "checkout", "identity.auth"],
  networkPolicy: "restricted",
  autoPromoteRiskTiers: ["low"],
  requiredChecksByRisk: {
    low: ["build", "targeted"],
    medium: ["build", "targeted", "contract"],
    high: ["build", "targeted", "contract", "security", "browser"],
  },
};

export type ChangeSetRow = {
  id: string;
  base_generation: number;
  artifact_ref: string | null;
  intent_json: string;
  created_at: string;
  task_id: string | null;
};

export type ComposeSource = {
  id: string;
  /** Artifacts fork that holds the ChangeSet commit. */
  fork: string;
  commit: string;
  files: string[];
};

export type TaskEdge = { task_id: string; depends_on_task_id: string };

const SHA = /^[0-9a-f]{40}$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Work Graph order: a ChangeSet merges after the ChangeSets of the Tasks it depends on. */
export function orderChangeSets(rows: readonly ChangeSetRow[], edges: readonly TaskEdge[]) {
  const byTask = new Map(rows.filter((r) => r.task_id).map((r) => [r.task_id as string, r.id]));
  const deps = new Map<string, Set<string>>();
  for (const row of rows) deps.set(row.id, new Set());
  for (const e of edges) {
    const from = byTask.get(e.task_id);
    const to = byTask.get(e.depends_on_task_id);
    if (from && to && from !== to) deps.get(from)?.add(to);
  }
  const pending = [...rows].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  const done = new Set<string>();
  const ordered: ChangeSetRow[] = [];
  while (pending.length > 0) {
    const index = pending.findIndex((r) => [...(deps.get(r.id) ?? [])].every((d) => done.has(d)));
    // A cycle cannot come from a validated Work Graph; fall back to creation order.
    const [next] = pending.splice(index === -1 ? 0 : index, 1);
    if (!next) break;
    ordered.push(next);
    done.add(next.id);
  }
  return { ordered, deps };
}

/** Parsed ChangeSets for `checkCompatibility` and the source merge. Throws on a malformed row. */
export function toComposable(rows: readonly ChangeSetRow[], deps: Map<string, Set<string>>) {
  const composable: ComposableChangeSet[] = [];
  const sources: ComposeSource[] = [];
  for (const row of rows) {
    const intent = ChangeSetIntent.parse(JSON.parse(row.intent_json));
    const dependsOn = [...(deps.get(row.id) ?? [])];
    composable.push({
      id: row.id,
      baseGeneration: row.base_generation,
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      intent,
    });
    // A ChangeSet without committed source (an Intent only) has nothing to merge.
    const cs = intent.changeSet;
    if (!cs) continue;
    if (!SHA.test(cs.commit) || !REPO_NAME.test(cs.fork)) {
      throw new Error(`ChangeSet ${row.id} has an invalid fork or commit`);
    }
    sources.push({ id: row.id, fork: cs.fork, commit: cs.commit, files: cs.files });
  }
  return { composable, sources };
}

export type ChangeFacts = {
  goal: string;
  invariants: readonly string[];
  acceptanceCriteria: readonly string[];
  files: readonly string[];
  touchesAuthorization: boolean;
};

const UI_FILE = /(^|\/)public\/|\.(tsx|jsx|html|css)$/;
const KEEP_UNCHANGED = /\b(unchanged|must remain|must not change)\b/i;

/** Verification scope from the Change and its ChangeSets (section 34.1: risk-based, not all). */
export function verificationTouches(facts: ChangeFacts) {
  const sentences = facts.goal
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  // Invariants come from the Work Graph; goal sentences that protect behavior also count, so an
  // unplanned Change still checks what the user asked to keep.
  const protectedInvariants = [
    ...new Set([...facts.invariants, ...sentences.filter((s) => KEEP_UNCHANGED.test(s))]),
  ];
  const texts = [facts.goal, ...facts.acceptanceCriteria, ...facts.invariants];
  const p95 = texts
    .map((t) => /\bp95\b[^.]*?(\d+(?:\.\d+)?)\s*ms\b/i.exec(t)?.[1])
    .find((v) => v !== undefined);
  return {
    touches: {
      authorization: facts.touchesAuthorization,
      performanceConstraint: texts.some((t) => /\bp95\b/i.test(t)),
      protectedInvariants,
      ui: facts.files.some((f) => UI_FILE.test(f)),
    },
    ...(p95 ? { p95BudgetMs: Number(p95) } : {}),
  };
}

/** Commands a check may run in the Sandbox. Plans come from code, and this keeps them honest. */
const CHECK_COMMANDS = [
  /^bun run (typecheck|test|bench)$/,
  /^bun test( [\w./-]+)*$/,
  /^bun test --test-name-pattern [\w-]+$/,
];

export const isAllowedCheckCommand = (command: string) =>
  !/[;&|`$<>\\\n]/.test(command) && CHECK_COMMANDS.some((re) => re.test(command));

export type CheckRun = {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  /** Sandbox or transport failure: the check did not produce a result. */
  error?: string;
};

export type CheckOutcome = {
  status: EvidenceStatus;
  coverage: EvidenceCoverage;
  summary: string;
  metrics?: Record<string, number>;
};

function tail(output: string, lines = 4, chars = 400) {
  const text = output.trim().split("\n").slice(-lines).join(" | ");
  return text.length > chars ? text.slice(-chars) : text;
}

/**
 * Turns one Sandbox command result into an Evidence outcome (section 34.4.1). A timeout, a
 * Sandbox error, or a run with no matching test is never a pass.
 */
export function classifyCheck(check: VerificationCheck, run: CheckRun): CheckOutcome {
  const seconds = Math.round(check.timeoutMs / 1000);
  if (run.timedOut) {
    return {
      status: "error",
      coverage: "not_checked",
      summary: `Timed out after ${seconds} s. A timeout is not a pass.`,
    };
  }
  if (run.error !== undefined || run.exitCode === null) {
    return {
      status: "error",
      coverage: "not_checked",
      summary: `Did not run: ${(run.error ?? "no exit code").slice(0, 200)}`,
    };
  }
  const exit = `exit ${run.exitCode}`;

  if (check.expected.kind === "metric_below") {
    const { metric, threshold } = check.expected;
    const value = metric === "p95Ms" ? parseBenchOutput(run.output) : null;
    if (run.exitCode !== 0) {
      return {
        status: "fail",
        coverage: "checked_supported",
        summary: `${exit}: ${tail(run.output)}`,
      };
    }
    if (value === null) {
      return {
        status: "error",
        coverage: "checked_no_signal",
        summary: `${exit}, but no ${metric} value in the output.`,
      };
    }
    const ok = value < threshold;
    return {
      status: ok ? "pass" : "fail",
      coverage: "checked_supported",
      summary: `${metric} ${value.toFixed(3)} ms ${ok ? "<" : ">="} ${threshold} ms budget.`,
      metrics: { [metric]: value },
    };
  }

  if (check.command?.startsWith("bun test")) {
    const passed = Number(/(\d+) pass\b/.exec(run.output)?.[1] ?? 0);
    const failed = Number(/(\d+) fail\b/.exec(run.output)?.[1] ?? 0);
    if (passed + failed === 0) {
      return {
        status: "error",
        coverage: "checked_no_signal",
        summary: `${exit}: no test matched. A check without tests is a gap, not a pass.`,
      };
    }
    const ok = run.exitCode === 0 && failed === 0;
    return {
      status: ok ? "pass" : "fail",
      coverage: "checked_supported",
      summary: `${exit}: ${passed} pass, ${failed} fail.${ok ? "" : ` ${tail(run.output)}`}`,
      metrics: { testsPassed: passed, testsFailed: failed },
    };
  }

  const ok = run.exitCode === 0;
  return {
    status: ok ? "pass" : "fail",
    coverage: "checked_supported",
    summary: ok ? `${exit}.` : `${exit}: ${tail(run.output)}`,
  };
}

/** Outcome for a check that has a procedure and no automated command yet. */
export function procedureGap(check: VerificationCheck): CheckOutcome {
  return {
    status: "skipped",
    coverage: "not_checked",
    summary: `Not automated yet (${check.kind}). This is a gap, never a pass.`,
  };
}
