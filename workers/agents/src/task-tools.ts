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

const ReadFileArgs = Type.Object({
  path: Type.String({
    minLength: 1,
    maxLength: 300,
    description: "Repository-relative file path.",
  }),
});
const ListFilesArgs = Type.Object({
  prefix: Type.Optional(
    Type.String({ maxLength: 300, description: "Only paths starting with this." }),
  ),
});

/** Read-only view of the canonical source, capped per run (Artifacts operations). */
export type SourceReader = {
  listFiles(prefix?: string): Promise<string>;
  readFile(path: string): Promise<string>;
};

export type TaskOutcomeSink = {
  complete(args: Static<typeof IntentArgs>): Promise<string>;
  fail(args: Static<typeof FailArgs>): Promise<string>;
};

/** One extension per run: the system prompt for the Task and its two terminal tools. */
export function taskExtension(
  prompt: () => string,
  sink: TaskOutcomeSink,
  source: SourceReader,
): Extension {
  const listFiles: ToolRegistration<typeof ListFilesArgs> = {
    name: "list_files",
    description: "List repository files at the canonical commit.",
    parameters: ListFilesArgs,
    replay: "safe",
    async execute(args) {
      return { content: [{ type: "text", text: await source.listFiles(args.prefix) }] };
    },
  };
  const readFile: ToolRegistration<typeof ReadFileArgs> = {
    name: "read_file",
    description:
      "Read one repository file at the canonical commit. Read before you plan changes to it.",
    parameters: ReadFileArgs,
    replay: "safe",
    async execute(args) {
      return { content: [{ type: "text", text: await source.readFile(args.path) }] };
    },
  };
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
    tools: [listFiles, readFile, complete, fail],
  } as unknown as Extension;
}
