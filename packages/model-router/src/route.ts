import type { DecisionReceipt, ModelTier, RouteDecision, RouteRequest } from "@rhumbatron/protocol";
import type { DecisionModel } from "./decision.ts";
import { resolveTier } from "./models.ts";
import { applyOpusPolicy, decisionFor, routeByRules } from "./rules.ts";

/**
 * ModelRouter (AGENTS.md section 23, P6-07). Deterministic rules decide whenever a specific rule
 * fires. Only the generic default goes to Clef-flash, and deterministic floors still apply to its
 * answer. Abstain or cap reached: the rules' answer stands. Last, policy: while Opus is off
 * (`ALLOW_OPUS` not "true", ADR 0021) an opus decision runs on Sonnet, and the receipt records
 * the requested tier and the downgrade.
 */

const TIERS: readonly ModelTier[] = ["haiku", "sonnet", "opus"];

/** Below this probability Clef abstains. Pass it to the DecisionModel that `routeStep` gets. */
export const CLEF_ROUTE_ABSTAIN_BELOW = 0.6;

export type RoutedStep = {
  decision: RouteDecision;
  receipt: Omit<DecisionReceipt, "taskId" | "agentId" | "createdAt">;
};

function floorOf(req: RouteRequest): ModelTier {
  const trivial = req.complexity === "small" && req.riskTier === "low";
  if (req.destructiveMigration) return "opus";
  if (req.touchesBilling || (req.touchesAuthorization && !trivial)) return "sonnet";
  return "haiku";
}

export async function routeStep(
  req: RouteRequest,
  clef?: DecisionModel,
  options: { allowOpus?: boolean } = {},
): Promise<RoutedStep> {
  const routed = await chooseTier(req, clef);
  const capped = applyOpusPolicy(routed.decision, options.allowOpus ?? true);
  if (!capped.requestedTier) return routed;
  const { requestedTier, ...decision } = capped;
  return {
    decision,
    receipt: {
      ...routed.receipt,
      selectedTier: decision.selectedTier,
      selectedModels: [resolveTier(decision.selectedTier, true).model],
      requestedTier,
      downgradeReason: "opus_disabled",
      reasons: decision.reasons,
      escalateOn: decision.escalateOn,
    },
  };
}

async function chooseTier(req: RouteRequest, clef?: DecisionModel): Promise<RoutedStep> {
  const rules = routeByRules(req);
  const signals = {
    complexity: req.complexity,
    riskTier: req.riskTier,
    attempt: req.attempt,
    designConflict: req.hasDesignConflict,
  };
  const receipt = (
    decision: RouteDecision,
    decidedBy: "rules" | "clef",
    probabilities?: Record<string, number>,
  ) => ({
    decisionType: "MODEL_ROUTE" as const,
    decidedBy,
    selectedTier: decision.selectedTier,
    selectedModels: [resolveTier(decision.selectedTier, true).model],
    reasons: decision.reasons,
    signals: probabilities ? { ...signals, probabilities } : signals,
    escalateOn: decision.escalateOn,
  });

  // Specific rules (and every retry) are deterministic and final.
  if (!clef || !rules.reasons.includes("default") || req.attempt > 1) {
    return { decision: rules, receipt: receipt(rules, "rules") };
  }

  const [answer] = await clef.decide({
    model: "clef-flash",
    state: {
      taskKind: req.taskKind,
      ...signals,
      affectedFiles: req.affectedFiles,
      expectedToolCalls: req.expectedToolCalls,
    },
    questions: [
      {
        id: "tier",
        prompt:
          "Which model tier is the cheapest one likely to complete this software task correctly?",
        options: TIERS,
      },
    ],
  });
  const choice = answer?.choice;
  if (!answer || answer.abstained || !choice || !TIERS.includes(choice as ModelTier)) {
    return { decision: rules, receipt: receipt(rules, "rules", answer?.probabilities) };
  }
  const floor = floorOf(req);
  const tier =
    TIERS.indexOf(choice as ModelTier) < TIERS.indexOf(floor) ? floor : (choice as ModelTier);
  const decision = decisionFor(
    tier,
    [`clef_${choice}`, ...(tier !== choice ? ["floor"] : [])],
    answer.probabilities[choice] ?? 0,
  );
  return { decision, receipt: receipt(decision, "clef", answer.probabilities) };
}
