import { CaretRight } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { AgentRunView, AgentView, TaskRun } from "../../lib/api";

/**
 * Plain words for the Agents page (spec 7.6). The API keeps the AGENTS.md section 22 role names
 * and the model tiers; the page shows four plain roles and product model names, and keeps the
 * raw values under "Technical details".
 */

const PLAIN_ROLE: Record<string, string> = {
  "Root Planner": "Planner",
  "Task Implementer": "Coding agent",
  "Architecture Reviewer": "Reviewer",
  "Specialist Reviewer": "Reviewer",
  "Conflict Challenger": "Reviewer",
  "Integration Judge": "Reviewer",
  "Verification Agent": "Checker",
  // Deterministic policy, never a model (AGENTS.md 22.7).
  "Release Agent": "Release",
};

/** "Task Implementer" -> "Coding agent". Unknown roles pass through unchanged. */
export const plainRole = (role: string) => PLAIN_ROLE[role] ?? role;

const TIER_NAME: Record<TaskRun["tier"], string> = {
  haiku: "Claude Haiku",
  sonnet: "Claude Sonnet",
  opus: "Claude Opus",
};

/** The model an attempt used, by product name. Paid overflow runs on Gemini (ADR 0016). */
export function modelName(
  tier: TaskRun["tier"] | null,
  provider: AgentRunView["provider"] = null,
): string | null {
  if (provider === "google-vertex-ai") return "Gemini";
  return tier ? TIER_NAME[tier] : null;
}

const FINISHED = new Set(["completed", "failed", "cancelled", "blocked"]);

/** One status per agent: Working while active, the Task result once it finished, else Idle. */
export function agentStatus(agent: AgentView): string {
  if (agent.state === "active") return agent.task.status;
  return FINISHED.has(agent.task.status) ? agent.task.status : "idle";
}

/** A closed native disclosure for raw ids, tiers and locks (common rule 9). */
export function Details({
  children,
  label = "Technical details",
}: {
  children: ReactNode;
  label?: ReactNode;
}) {
  return (
    <details className="group text-[12px] text-kumo-subtle">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-accent-500 [&::-webkit-details-marker]:hidden">
        <CaretRight
          size={12}
          aria-hidden
          className="transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
        />
        {label}
      </summary>
      <div className="grid gap-4 pt-3 text-kumo-default">{children}</div>
    </details>
  );
}
Details.displayName = "Details";
