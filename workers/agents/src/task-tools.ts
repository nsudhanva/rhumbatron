import { type Static, Type } from "@earendil-works/pi-ai";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";

/**
 * The typed outputs an agent may produce. Completing a Task declares its Intent: what it changes,
 * where, and on what assumptions.
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
  fromLine: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "First line to return (1 by default). A long file says where it continues.",
    }),
  ),
});
const ListFilesArgs = Type.Object({
  prefix: Type.Optional(
    Type.String({ maxLength: 300, description: "Only paths starting with this." }),
  ),
});

const WriteFileArgs = Type.Object({
  path: Type.String({
    minLength: 1,
    maxLength: 300,
    description: "Repository-relative file path.",
  }),
  content: Type.String({ maxLength: 60_000, description: "The complete new file content." }),
});
const EditFileArgs = Type.Object({
  path: Type.String({
    minLength: 1,
    maxLength: 300,
    description: "Repository-relative path of an existing file.",
  }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({
        minLength: 1,
        maxLength: 20_000,
        description:
          "Exact current text, found exactly once in the file. Include enough lines to be unique.",
      }),
      newText: Type.String({ maxLength: 60_000, description: "The replacement text." }),
    }),
    { minItems: 1, maxItems: 20, description: "Applied in order." },
  ),
});
export type FileEdit = { oldText: string; newText: string };

/** Characters of a file one read returns; a longer file continues with `fromLine`. */
const READ_FILE_CHARS = 40_000;

/**
 * Pure: the lines of a file from `fromLine`, at most `cap` characters, cut at a line boundary.
 * A cut ends with a note that says where the file continues.
 */
export function fileWindow(text: string, fromLine = 1, cap = READ_FILE_CHARS): string {
  const lines = text.split("\n");
  if (fromLine > lines.length) return `The file has ${lines.length} lines.`;
  const out: string[] = [];
  let used = 0;
  let line = fromLine;
  for (; line <= lines.length; line++) {
    const next = lines[line - 1] ?? "";
    if (used + next.length + 1 > cap && out.length > 0) break;
    out.push(next);
    used += next.length + 1;
  }
  const head = fromLine > 1 ? `(lines ${fromLine} to ${line - 1} of ${lines.length})\n` : "";
  const tail =
    line <= lines.length
      ? `\n… (the file continues at line ${line} of ${lines.length}: call read_file with fromLine ${line})`
      : "";
  return `${head}${out.join("\n")}${tail}`;
}

/**
 * Pure: applies exact edits in order. Each `oldText` must occur exactly once in the text as it is
 * after the earlier edits; otherwise nothing is applied and the error names the edit.
 */
export function applyEdits(
  text: string,
  edits: readonly FileEdit[],
): { ok: true; text: string } | { ok: false; error: string } {
  let current = text;
  for (const [i, edit] of edits.entries()) {
    const at = current.indexOf(edit.oldText);
    if (at === -1)
      return {
        ok: false,
        error: `Edit ${i + 1}: oldText was not found. Read the file again and copy the exact text.`,
      };
    if (current.indexOf(edit.oldText, at + 1) !== -1)
      return {
        ok: false,
        error: `Edit ${i + 1}: oldText occurs more than once. Include more surrounding lines.`,
      };
    current = current.slice(0, at) + edit.newText + current.slice(at + edit.oldText.length);
  }
  return { ok: true, text: current };
}

const DeleteFileArgs = Type.Object({
  path: Type.String({
    minLength: 1,
    maxLength: 300,
    description: "Repository-relative file path.",
  }),
});
const RunCommandArgs = Type.Object({
  command: Type.String({
    minLength: 2,
    maxLength: 200,
    description:
      "One of: bun install, bun test [paths], bun run typecheck|test|bench|contract|build, bun run <a script in package.json>, bunx tsc --noEmit, git status|diff|log, ls.",
  }),
});

/**
 * Source access for one run: reads come from the workspace when it is open, else from the
 * canonical commit. Writes and commands open the Task's workspace (implementation Tasks only).
 */
export type SourceReader = {
  listFiles(prefix?: string): Promise<string>;
  readFile(path: string, fromLine?: number): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
  editFile(path: string, edits: FileEdit[]): Promise<string>;
  deleteFile(path: string): Promise<string>;
  runCommand(command: string): Promise<string>;
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
      "Read one repository file at the canonical commit. Read before you plan changes to it. A long file is returned in parts: continue with fromLine.",
    parameters: ReadFileArgs,
    replay: "safe",
    async execute(args) {
      return {
        content: [{ type: "text", text: await source.readFile(args.path, args.fromLine) }],
      };
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
  const writeFile: ToolRegistration<typeof WriteFileArgs> = {
    name: "write_file",
    description:
      "Create a new file, or replace a small one, in your Task workspace. Write the complete content. To change an existing file, use edit_file.",
    parameters: WriteFileArgs,
    replay: "safe",
    async execute(args) {
      return { content: [{ type: "text", text: await source.writeFile(args.path, args.content) }] };
    },
  };
  const editFile: ToolRegistration<typeof EditFileArgs> = {
    name: "edit_file",
    description:
      "Change an existing file in your Task workspace with exact replacements: each oldText must occur once. Prefer this to write_file for existing files: it keeps your output small.",
    parameters: EditFileArgs,
    replay: "safe",
    async execute(args) {
      return { content: [{ type: "text", text: await source.editFile(args.path, args.edits) }] };
    },
  };
  const deleteFile: ToolRegistration<typeof DeleteFileArgs> = {
    name: "delete_file",
    description: "Delete one file in your Task workspace.",
    parameters: DeleteFileArgs,
    replay: "safe",
    async execute(args) {
      return { content: [{ type: "text", text: await source.deleteFile(args.path) }] };
    },
  };
  const runCommand: ToolRegistration<typeof RunCommandArgs> = {
    name: "run_command",
    description:
      "Run an allowed command in your Task workspace, for example bun test or bun run typecheck.",
    parameters: RunCommandArgs,
    replay: "safe",
    async execute(args) {
      return { content: [{ type: "text", text: await source.runCommand(args.command) }] };
    },
  };
  return {
    name: "rhumbatron-task",
    sections: [{ key: "task", render: prompt, tag: false }],
    tools: [listFiles, readFile, writeFile, editFile, deleteFile, runCommand, complete, fail],
  } as unknown as Extension;
}
