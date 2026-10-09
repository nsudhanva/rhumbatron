import type {
  PolicyCheck,
  ProjectPolicy,
  RiskTier,
  VerificationCheck,
  VerificationPlan,
} from "@rhumbatron/protocol";

/**
 * Risk-based Verification Plan (AGENTS.md sections 34.1, 34.2, 53). Commands target the Acme Shop
 * toolchain (`fixtures/acme-shop`): they run inside the Candidate Sandbox at the repository root.
 */

export type VerificationTouches = {
  /** The Candidate changes who may do what; security Evidence and a human gate are required. */
  authorization: boolean;
  /** The Change carries a latency constraint, for example "Keep API p95 below 200 ms". */
  performanceConstraint: boolean;
  /** Protected invariants in scope, for example "Existing cart behavior must remain unchanged." */
  protectedInvariants: readonly string[];
  /** The Candidate changes user-facing pages. */
  ui: boolean;
};

export type BuildVerificationPlanInput = {
  candidateId: string;
  riskTier: RiskTier;
  policy: Pick<ProjectPolicy, "version" | "humanGateRiskTiers" | "requiredChecksByRisk">;
  touches: VerificationTouches;
  /** Wishlist API p95 budget in the demo benchmark (section 54). */
  p95BudgetMs?: number;
};

const TIERS: readonly RiskTier[] = ["low", "medium", "high", "critical"];
const MINIMUM_CHECKS: readonly PolicyCheck[] = ["build", "targeted"];

const STD = ["report.json", "stdout.txt.zst"];

/** Test-name filter of the security check. Authorization tests must carry it in their name. */
export const SECURITY_TEST_PATTERN = "authorization";
/** Browser check budget: one Browser Run session (at most 55 s) plus Evidence upload. */
export const BROWSER_CHECK_TIMEOUT_MS = 90_000;
const exit0 = { kind: "exit_code", code: 0 } as const;

/**
 * Policy checks for a tier. A tier the policy does not list uses the next stricter listed tier, so a
 * gap in policy never lowers verification; with no stricter tier, the strictest listed one applies.
 */
function policyChecks(
  byRisk: BuildVerificationPlanInput["policy"]["requiredChecksByRisk"],
  tier: RiskTier,
): Set<PolicyCheck> {
  const from = TIERS.indexOf(tier);
  const stricter = TIERS.slice(from).find((t) => byRisk[t] !== undefined);
  const fallback = [...TIERS].reverse().find((t) => byRisk[t] !== undefined);
  const listed = byRisk[stricter ?? fallback ?? tier] ?? [];
  return new Set([...MINIMUM_CHECKS, ...listed]);
}

function atLeast(tier: RiskTier, floor: RiskTier): boolean {
  return TIERS.indexOf(tier) >= TIERS.indexOf(floor);
}

function invariantSlug(invariant: string, index: number): string {
  const slug = invariant
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `protected-invariant-${index + 1}${slug ? `-${slug}` : ""}`;
}

export function buildVerificationPlan(input: BuildVerificationPlanInput): VerificationPlan {
  const { candidateId, riskTier, policy, touches } = input;
  const p95BudgetMs = input.p95BudgetMs ?? 200;
  const wanted = policyChecks(policy.requiredChecksByRisk, riskTier);
  const checks: VerificationCheck[] = [];

  if (wanted.has("build")) {
    checks.push({
      checkId: "build",
      kind: "build",
      reason: "The Candidate must compile before any other Evidence counts.",
      command: "bun run typecheck",
      timeoutMs: 120_000,
      required: true,
      expected: exit0,
      evidenceOutput: [...STD],
    });
  }
  if (wanted.has("targeted")) {
    checks.push({
      checkId: "unit",
      kind: "unit",
      reason: "Project tests must pass on the composed source.",
      command: "bun test",
      timeoutMs: 180_000,
      required: true,
      expected: exit0,
      evidenceOutput: [...STD],
    });
  }
  if (wanted.has("contract")) {
    checks.push({
      checkId: "contract",
      kind: "contract",
      reason: `Risk tier ${riskTier} requires contract Evidence for declared API and data changes.`,
      procedure:
        "Diff the composed API route table against the base (bun run contract) and match each " +
        "added or removed route to the declared expectedContractChanges; any undeclared change fails.",
      timeoutMs: 120_000,
      required: true,
      expected: {
        kind: "procedure",
        description: "Every observed contract change is declared",
      },
      evidenceOutput: ["report.json"],
    });
  }

  touches.protectedInvariants.forEach((invariant, index) => {
    const isCart = /\bcart\b/i.test(invariant);
    // One Cart invariant check covers every invariant that names the Cart.
    if (isCart && checks.some((c) => c.checkId === "protected-invariant-cart")) return;
    checks.push(
      isCart
        ? {
            checkId: "protected-invariant-cart",
            kind: "protected-invariant",
            reason: `Protected invariant: ${invariant}`,
            command: "bun test test/cart.invariant.test.ts",
            timeoutMs: 120_000,
            required: true,
            expected: exit0,
            evidenceOutput: [...STD],
          }
        : {
            checkId: invariantSlug(invariant, index),
            kind: "protected-invariant",
            reason: `Protected invariant: ${invariant}`,
            procedure: `Run a check that proves this invariant still holds: ${invariant}`,
            timeoutMs: 180_000,
            required: true,
            expected: { kind: "procedure", description: invariant },
            evidenceOutput: ["report.json"],
          },
    );
  });

  if (touches.performanceConstraint) {
    checks.push({
      checkId: "performance",
      kind: "performance",
      reason: `The Change requires API p95 below ${p95BudgetMs} ms.`,
      command: "bun run bench",
      timeoutMs: 120_000,
      required: true,
      expected: { kind: "metric_below", metric: "p95Ms", threshold: p95BudgetMs },
      evidenceOutput: [...STD],
    });
  }

  if (wanted.has("security") || touches.authorization) {
    checks.push({
      checkId: "security",
      kind: "security",
      reason: touches.authorization
        ? "The Candidate changes authorization; denied actions must stay denied."
        : `Risk tier ${riskTier} requires security Evidence.`,
      // Runs only the tests whose name contains `authorization`. Zero matched or all skipped is
      // `checked_no_signal`, a gap; only exit 0 with at least one executed test passes.
      command: `bun test --test-name-pattern ${SECURITY_TEST_PATTERN}`,
      timeoutMs: 180_000,
      required: true,
      expected: exit0,
      evidenceOutput: [...STD],
    });
  }

  // Browser Run is metered (section 7.3): only a high-risk Change that touches pages gets it.
  if (touches.ui && atLeast(riskTier, "high")) {
    checks.push({
      checkId: "browser",
      kind: "browser",
      reason: "High-risk user-facing change: run the end-to-end flow in Browser Run.",
      procedure:
        "Start the composed app in the Sandbox (bun run dev) and open it in one Browser Run " +
        "session. With Wishlist UI, run the section 35 flow: owner creates and shares, " +
        "collaborator adds and removes, owner revokes, a later collaborator write is denied. " +
        "Otherwise open the shop, add to cart, and verify the total. Every step must pass.",
      // One session of at most 55 s plus screenshot upload; Sandbox restore is not counted.
      timeoutMs: BROWSER_CHECK_TIMEOUT_MS,
      required: true,
      expected: { kind: "procedure", description: "Every flow step passes (k/N with k = N)" },
      evidenceOutput: ["report.json", "stdout.txt", "screenshot-<n>.png"],
    });
  }

  return {
    candidateId,
    checks,
    requiredCheckIds: checks.filter((c) => c.required).map((c) => c.checkId),
    humanApprovalRequired: policy.humanGateRiskTiers.includes(riskTier) || touches.authorization,
    policyVersion: policy.version,
  };
}
