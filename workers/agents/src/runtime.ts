import type { ModelTier } from "@rhumbatron/protocol";

/**
 * Agent Runtime boundary (AGENTS.md section 25). Application code depends on this interface, never
 * on Pi types, so the harness can change without touching callers.
 */

export type AgentRunInput = {
  agentId: string;
  taskId: string;
  changeId: string;
  projectId: string;
  orgId: string;
  projectSlug: string;
  baseGeneration: number;
};

export type AgentRunState =
  | { status: "idle" }
  | { status: "running"; runId: string; attempt: number; tier: ModelTier }
  | {
      status: "completed" | "failed";
      runId: string;
      attempt: number;
      tier: ModelTier;
      reason?: string;
    };

export type AgentRunResult = { runId: string; accepted: boolean; state: AgentRunState };

export type AgentResumeEvent = {
  kind: "dependency_changed" | "challenge" | "canonical_advanced";
  eventId: string;
};

export interface AgentRuntime {
  start(input: AgentRunInput): Promise<AgentRunResult>;
  resume(runId: string, event: AgentResumeEvent): Promise<AgentRunResult>;
  cancel(runId: string): Promise<void>;
  getState(runId: string): Promise<AgentRunState>;
}
