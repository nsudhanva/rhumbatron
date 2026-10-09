import { type Static, Type } from "@earendil-works/pi-ai";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";

/**
 * The typed outputs an agent may produce (AGENTS.md section 26). Until Workspaces exist (Phase 8),
 * completing a Task means declaring its Intent: what it would change, where, and on what assumptions.
 */

export const IntentArgs = Type.Object({
  summary: Type.String({
    minLength: 10,
    maxLength: 2000,
    description: "What the change does and why.",
  }),
  semanticResources: Type.Array(Type.String(), {
    maxItems: 10,
    description: "Product areas touched, e.g. wishlist:membership.",
  }),
  expectedFiles: Type.Array(Type.String(), {
    maxItems: 30,
    description: "Files you would create or modify.",
  }),
  expectedContractChanges: Type.Array(Type.String(), {
    maxItems: 20,
    description: "API, event, or schema contract changes.",
  }),
  expectedDataChanges: Type.Array(Type.String(), {
    maxItems: 20,
    description: "Tables, columns, or stored data changes.",
  }),
  assumptions: Type.Array(Type.String(), {
    maxItems: 20,
    description: "Assumptions other Tasks must respect.",
  }),
  acceptanceEvidence: Type.Array(Type.String(), {
    maxItems: 20,
    description: "How each acceptance criterion will be checked.",
  }),
});

export const FailArgs = Type.Object({
  reason: Type.String({ minLength: 5, maxLength: 1000 }),
  kind: Type.Union([
    Type.Literal("blocked_by_missing_information"),
    Type.Literal("out_of_scope"),
    Type.Literal("cannot_complete"),
  ]),
});

export type TaskOutcomeSink = {
  complete(args: Static<typeof IntentArgs>): Promise<string>;
  fail(args: Static<typeof FailArgs>): Promise<string>;
};

/** One extension per run: the system prompt for the Task and its two terminal tools. */
export function taskExtension(prompt: () => string, sink: TaskOutcomeSink): Extension {
  const complete: ToolRegistration<typeof IntentArgs> = {
    name: "complete_task",
    description: "Declare the Intent for this Task and finish it. Call exactly once when done.",
    parameters: IntentArgs,
    // Idempotent: the sink uses conditional updates and stable event IDs.
    replay: "safe",
    async execute(args) {
      return { content: [{ type: "text", text: await sink.complete(args) }] };
    },
  };
  const fail: ToolRegistration<typeof FailArgs> = {
    name: "fail_task",
    description: "Stop because the Task cannot be completed as specified. Explain why.",
    parameters: FailArgs,
    replay: "safe",
    async execute(args) {
      return { content: [{ type: "text", text: await sink.fail(args) }] };
    },
  };
  return {
    name: "rhumbatron-task",
    sections: [{ key: "task", render: prompt, tag: false }],
    tools: [complete, fail],
  } as unknown as Extension;
}
