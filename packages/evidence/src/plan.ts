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
  /** APPS is available and the Project has an app, including its pending first deployment. */
  liveAppEnabled?: boolean;
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

const LATENCY = /\bp9[59]\b|\blatency\b/i;
const CART = /\bcarts?\b/i;
/** Parts of the shop whose existing behavior the contract diff and the project tests cover. */
const ENDPOINT_SUBJECT =
  /\b(products?|catalog(ue)?|listings?|api|apis|routes?|endpoints?|http|responses?)\b/i;
/** Wording that asks to keep existing behavior, not to add a new property. */
const PRESERVE =
  /\b(existing|unchanged|must remain|remains?|preserved?|backwards?[- ]compatible|regressions?|(do|does|must|should|will) not (change|break|alter|modify)|(don't|doesn't|never) (change|break|alter|modify)|without (changing|breaking)|keeps?|still|continues? to|stays?|always)\b/i;
/** An invariant that names an HTTP route: the route table and the project tests prove it. */
const ROUTE_REF = /\b(GET|POST|PUT|PATCH|DELETE|HEAD)\s+\//;

/**
 * True when the invariant protects existing product, catalog, API, route, or endpoint behavior.
 * The Acme fixture proves it deterministically: `bun run contract` fails on any undeclared route
 * change, and `bun test` (test/catalog.test.ts) pins product list, detail, 404, and 401 behavior.
 */
function protectsExistingEndpoints(invariant: string): boolean {
  return (
    ROUTE_REF.test(invariant) || (ENDPOINT_SUBJECT.test(invariant) && PRESERVE.test(invariant))
  );
}

/**
 * True for any other app-behavior invariant ("Todos stay saved per day", "Todos are separate per
 * day"). On a generated app the agents' own project tests are the deterministic Evidence for it.
 */
function protectsAppBehavior(invariant: string): boolean {
  return !OUTSIDE_TESTS.test(invariant);
}

/**
 * Invariants a unit test cannot prove: delivery outside the app, wall-clock timing, uptime. These
 * stay visible required gaps (AGENTS.md section 34.4.1). Latency maps to the performance check.
 */
const OUTSIDE_TESTS =
  /\b(e-?mails?|sms|text messages?|push notifications?|notifications? (are|is) (sent|delivered)|within \d+\s*(ms|milliseconds?|seconds?|minutes?|hours?)|uptime|availability|sla)\b/i;

function unitCheck(reason: string): VerificationCheck {
  return {
    checkId: "unit",
    kind: "unit",
    reason,
    command: "bun test",
    timeoutMs: 180_000,
    required: true,
    expected: exit0,
    evidenceOutput: [...STD],
  };
}

function contractCheck(reason: string): VerificationCheck {
  return {
    checkId: "contract",
    kind: "contract",
    reason,
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
  };
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
    checks.push(unitCheck("Project tests must pass on the composed source."));
  }
  if (wanted.has("contract") || input.liveAppEnabled) {
    checks.push(
      contractCheck(
        input.liveAppEnabled
          ? "Live app smoke probes need the composed API route table and declared contract changes."
          : `Risk tier ${riskTier} requires contract Evidence for declared API and data changes.`,
      ),
    );
  }

  touches.protectedInvariants.forEach((invariant, index) => {
    // A latency invariant is what the performance check measures; a procedure would only be a gap.
    if (touches.performanceConstraint && LATENCY.test(invariant)) return;
    const isCart = CART.test(invariant);
    const isRegression = protectsExistingEndpoints(invariant);
    if (isCart) {
      // One Cart invariant check covers every invariant that names the Cart.
      const cart = checks.find((c) => c.checkId === "protected-invariant-cart");
      if (cart) {
        cart.reason += `; ${invariant}`;
      } else {
        checks.push({
          checkId: "protected-invariant-cart",
          kind: "protected-invariant",
          reason: `Protected invariant: ${invariant}`,
          command: "bun test test/cart.invariant.test.ts",
          timeoutMs: 120_000,
          required: true,
          expected: exit0,
          evidenceOutput: [...STD],
        });
      }
    }
    if (isRegression) {
      // Existing endpoint behavior is what the route-table diff and the project tests prove.
      const note = `Protected invariant (mapped: existing endpoints -> contract + unit): ${invariant}`;
      for (const [id, make] of [
        ["contract", contractCheck],
        ["unit", unitCheck],
      ] as const) {
        const check = checks.find((c) => c.checkId === id);
        if (check) check.reason += ` ${note}`;
        else checks.push(make(note));
      }
    }
    if (isCart || isRegression) return;
    if (protectsAppBehavior(invariant)) {
      const note = `Protected invariant (mapped: app behavior -> project tests): ${invariant}`;
      const unit = checks.find((c) => c.checkId === "unit");
      if (unit) unit.reason += ` ${note}`;
      else checks.push(unitCheck(note));
      return;
    }
    // Maps to no deterministic Evidence: a required procedure that stays a visible gap.
    checks.push({
      checkId: invariantSlug(invariant, index),
      kind: "protected-invariant",
      reason: `Protected invariant: ${invariant}`,
      procedure: `Run a check that proves this invariant still holds: ${invariant}`,
      timeoutMs: 180_000,
      required: true,
      expected: { kind: "procedure", description: invariant },
      evidenceOutput: ["report.json"],
    });
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

  if (input.liveAppEnabled) {
    checks.push({
      checkId: "preview-smoke",
      kind: "smoke",
      reason: "The live app must answer the release probes before Canonical State can advance.",
      procedure:
        "Publish the Candidate preview, then run the release GET probes through APPS against " +
        "its preview channel and isolated DATA store. Every probe must answer as expected.",
      timeoutMs: 30_000,
      required: true,
      expected: { kind: "procedure", description: "Every preview smoke probe passes" },
      evidenceOutput: ["report.json", "stdout.txt"],
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
