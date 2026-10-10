import {
  applyOpusPolicy,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  routeByRules,
} from "@rhumbatron/model-router";
import { checkWorkGraph, type RouteRequest, WorkGraphPlan } from "@rhumbatron/protocol";
import { z } from "zod";

/**
 * Root Planner contract (AGENTS.md sections 22.1 and 47 P5-02). The model must answer with one
 * `submit_work_graph` tool call. Application code validates it; the model never decides its scope.
 */

const SUBMIT_TOOL = "submit_work_graph";

const SYSTEM_PROMPT = `You are the Root Planner of Rhumbatron, a system where many software agents change one codebase in parallel.
Turn the user's goal into a small dependency graph of Tasks. Rules:
- 2 to 8 Tasks. Each Task is one bounded unit of work that one agent can finish and verify alone.
- Keys are t1, t2, ... in order. dependsOn lists keys that must finish first. No cycles.
- Tasks that do not depend on each other must not list each other, so they can run in parallel.
- semanticResources are colon-separated kebab-case product areas, for example wishlist:membership or cart:totals.
- Use kind "design" only for decisions other Tasks need first; "test" for verification work; "document" sparingly.
- acceptanceCriteria are observable results, not activities.
- invariants are behaviours that must not change, taken from the goal (for example existing cart behaviour).
- riskTier: high when a Task changes authorization, data ownership, or migrations; critical only for destructive changes.
- Do not plan deployment or release Tasks; Rhumbatron releases automatically.
Call ${SUBMIT_TOOL} exactly once. Do not write any other text.`;

export type PlannerInput = { goal: string; projectName: string };

export type PlannerResult = {
  plan: WorkGraphPlan;
  /** Topological order of Task keys. */
  order: string[];
  attempts: number;
  calls: Pick<
    CompletionResult,
    "provider" | "model" | "inputTokens" | "outputTokens" | "costUsd" | "latencyMs" | "gatewayLogId"
  >[];
  /** `requestedTier` is set when policy lowered the tier (ADR 0021: Opus off). */
  route: { tier: string; reasons: string[]; requestedTier?: string };
};

export class PlannerError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly lastErrors: string[],
  ) {
    super(message);
  }
}

type Complete = (req: CompletionRequest) => Promise<CompletionResult>;

const PLANNER_ROUTE: RouteRequest = {
  taskKind: "plan",
  complexity: "large",
  riskTier: "medium",
  affectedFiles: 0,
  affectedResources: [],
  attempt: 1,
  priorFailureKinds: [],
  hasDesignConflict: false,
  touchesAuthorization: false,
  touchesBilling: false,
  touchesMigration: false,
  destructiveMigration: false,
  contextTokensEstimate: 1500,
  expectedToolCalls: 1,
  budgetRemainingUsd: 3,
};

const tool = {
  type: "function" as const,
  function: {
    name: SUBMIT_TOOL,
    description: "Submit the Work Graph for the goal.",
    parameters: z.toJSONSchema(WorkGraphPlan) as Record<string, unknown>,
  },
};

/** Parses and checks one tool call. Returns the plan or human-readable errors for a repair turn. */
export function parsePlan(
  args: string | undefined,
): { ok: true; plan: WorkGraphPlan; order: string[] } | { ok: false; errors: string[] } {
  if (!args) return { ok: false, errors: [`no ${SUBMIT_TOOL} call`] };
  let json: unknown;
  try {
    json = JSON.parse(args);
  } catch {
    return { ok: false, errors: ["arguments are not valid JSON"] };
  }
  const parsed = WorkGraphPlan.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join(".") || "root"}: ${i.message}`),
    };
  }
  const graph = checkWorkGraph(parsed.data.tasks);
  return graph.ok ? { ok: true, plan: parsed.data, order: graph.order } : graph;
}

/** At most two model calls: the plan, then one repair turn with the validation errors. */
export async function planChange(
  input: PlannerInput,
  complete: Complete,
  options: { allowOpus?: boolean } = {},
): Promise<PlannerResult> {
  const route = applyOpusPolicy(routeByRules(PLANNER_ROUTE), options.allowOpus ?? true);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Project: ${input.projectName}\nGoal:\n${input.goal}` },
  ];
  const calls: PlannerResult["calls"] = [];
  let lastErrors: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await complete({
      tier: route.selectedTier,
      maxOutputTokens: route.maxOutputTokens,
      messages,
      tools: [tool],
      metadata: { source: "root-planner", attempt: String(attempt) },
    });
    calls.push({
      provider: result.provider,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      gatewayLogId: result.gatewayLogId,
    });

    const call = result.toolCalls.find((c) => c.function.name === SUBMIT_TOOL);
    const outcome = parsePlan(call?.function.arguments);
    if (outcome.ok) {
      return {
        plan: outcome.plan,
        order: outcome.order,
        attempts: attempt,
        calls,
        route: {
          tier: route.selectedTier,
          reasons: route.reasons,
          ...(route.requestedTier ? { requestedTier: route.requestedTier } : {}),
        },
      };
    }
    lastErrors = outcome.errors;

    // Repair turn: show the model its own call and the exact validation errors.
    if (call) {
      // The whole assistant turn, thinking blocks included, as the API requires for a tool turn.
      messages.push(result.message);
      // Every tool call of the turn needs its result; only the first submit call is checked.
      for (const other of result.toolCalls) {
        messages.push({
          role: "tool",
          tool_call_id: other.id,
          content:
            other.id === call.id
              ? `Rejected. Fix these errors and call ${SUBMIT_TOOL} again:\n- ${outcome.errors.join("\n- ")}`
              : `Ignored. Call ${SUBMIT_TOOL} exactly once.`,
        });
      }
    } else {
      messages.push(result.message);
      messages.push({
        role: "user",
        content: `You must call ${SUBMIT_TOOL}. Errors:\n- ${outcome.errors.join("\n- ")}`,
      });
    }
  }
  throw new PlannerError("Root Planner did not produce a valid Work Graph", 2, lastErrors);
}
