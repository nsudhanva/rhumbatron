import { z } from "zod";

/**
 * Code store and diffs (AGENTS.md sections 15.4 `patchRef`, 29, 38.5; Phase 16 P16-16, P16-17).
 * Everything lives under the Project's `source/<project>/` R2 prefix, so archive cleanup removes it
 * and no lifecycle rule expires it:
 *
 * - `source/<project>/<tree>/index.json`: file paths of one canonical tree (existing).
 * - `source/<project>/<tree>/code.json`: path to blob map of the same tree (`CodeManifest`).
 * - `source/<project>/blobs/<blob sha>`: file bytes, content-addressed by Git blob ID.
 * - `source/<project>/patches/changesets/<cs id>.patch`: `git diff` of one ChangeSet.
 * - `source/<project>/patches/candidates/<cand id>.patch`: `git diff` of one Candidate vs base.
 */

/** Patches above this size are cut at a line boundary and marked truncated. */
export const MAX_PATCH_BYTES = 512 * 1024;
/** Blobs above this size are listed but not copied to R2. */
export const MAX_CODE_BLOB_BYTES = 1024 * 1024;

const Sha = z.string().regex(/^[0-9a-f]{40}$/);

export const sourceIndexKey = (projectId: string, treeSha: string) =>
  `source/${projectId}/${treeSha}/index.json`;
export const codeManifestKey = (projectId: string, treeSha: string) =>
  `source/${projectId}/${treeSha}/code.json`;
export const codeBlobKey = (projectId: string, blob: string) => `source/${projectId}/blobs/${blob}`;
export const changeSetPatchKey = (projectId: string, changeSetId: string) =>
  `source/${projectId}/patches/changesets/${changeSetId}.patch`;
export const candidatePatchKey = (projectId: string, candidateId: string) =>
  `source/${projectId}/patches/candidates/${candidateId}.patch`;

/** One file of a canonical tree. `size` is null until the blob was read; `stored` = bytes in R2. */
export const CodeEntry = z.object({
  path: z.string().min(1),
  blob: Sha,
  size: z.number().int().nonnegative().nullable(),
  stored: z.boolean(),
});
export type CodeEntry = z.infer<typeof CodeEntry>;

/** `complete` is false while blobs are still to copy (a bounded write budget per call). */
export const CodeManifest = z.object({
  commit: Sha,
  treeSha: Sha,
  entries: z.array(CodeEntry),
  complete: z.boolean(),
});
export type CodeManifest = z.infer<typeof CodeManifest>;

/* ------------------------------------------------------------------------------------------ */
/* Patches                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * Shell command for the Sandbox: the size of `git diff from..to` on the first line, then at most
 * MAX_PATCH_BYTES + 1 bytes of it. Both refs must be full commit IDs (validated here).
 */
export function patchCommand(from: string, to: string) {
  if (!Sha.safeParse(from).success || !(to === "HEAD" || Sha.safeParse(to).success)) {
    throw new Error("invalid patch range");
  }
  return `f=$(mktemp) && git diff --no-color --no-ext-diff -M ${from} ${to} > "$f" && wc -c < "$f" && head -c ${MAX_PATCH_BYTES + 1} "$f"; rm -f "$f"`;
}

export type BoundedPatch = { patch: string; bytes: number; truncated: boolean };

/** UTF-8 byte length without TextEncoder (this package has no runtime globals). */
function utf8Length(text: string) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * Reads `patchCommand` output and bounds the patch to `max` bytes. A cut patch ends at the last
 * complete line, so no partial line or broken UTF-8 sequence remains.
 */
export function boundPatch(output: string, max = MAX_PATCH_BYTES): BoundedPatch {
  const newline = output.indexOf("\n");
  const head = newline === -1 ? output : output.slice(0, newline);
  const sized = /^\s*(\d+)\s*$/.exec(head);
  const raw = sized ? (newline === -1 ? "" : output.slice(newline + 1)) : output;
  const length = utf8Length(raw);
  const bytes = sized ? Number(sized[1]) : length;
  if (length <= max && bytes <= max) return { patch: raw, bytes, truncated: false };
  let used = 0;
  let end = 0;
  // Whole lines only: the line that would cross `max` and everything after it are dropped.
  while (end < raw.length) {
    const next = raw.indexOf("\n", end);
    if (next === -1) break;
    const size = utf8Length(raw.slice(end, next + 1));
    if (used + size > max) break;
    used += size;
    end = next + 1;
  }
  return { patch: raw.slice(0, end), bytes: Math.max(bytes, length), truncated: true };
}

/** R2 custom metadata of a stored patch (strings only). */
export const patchMetadata = (input: { base: string; head: string } & BoundedPatch) => ({
  base: input.base,
  head: input.head,
  bytes: String(input.bytes),
  truncated: input.truncated ? "true" : "false",
});

export const DiffFileStatus = z.enum(["added", "deleted", "modified", "renamed"]);

export const DiffFile = z.object({
  path: z.string(),
  /** The path before a rename, else null. */
  oldPath: z.string().nullable(),
  status: DiffFileStatus,
  binary: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** Unified hunks from the first `@@` line; empty for binary or mode-only changes. */
  patch: z.string(),
  /** The stored patch was cut inside this file. */
  truncated: z.boolean(),
});
export type DiffFile = z.infer<typeof DiffFile>;

/** Strips git's `a/` or `b/` prefix and C-style quoting from a header path. */
function headerPath(value: string): string | null {
  let text = value.trim();
  if (text === "/dev/null") return null;
  if (text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return text.replace(/^[ab]\//, "");
}

/** Paths from `diff --git a/x b/y` when both sides are unquoted and equal length (no rename). */
function gitHeaderPaths(line: string): [string, string] | null {
  const rest = line.slice("diff --git ".length);
  const quoted = /^"a\/((?:[^"\\]|\\.)*)" "b\/((?:[^"\\]|\\.)*)"$/.exec(rest);
  if (quoted) return [quoted[1] ?? "", quoted[2] ?? ""];
  if (!rest.startsWith("a/")) return null;
  // `a/<p> b/<p>`: the split is unambiguous when both halves are the same path.
  const half = (rest.length - 1) / 2;
  const a = rest.slice(2, half);
  const b = rest.slice(half + 3);
  if (a === b) return [a, b];
  const at = rest.indexOf(" b/");
  return at === -1 ? null : [rest.slice(2, at), rest.slice(at + 3)];
}

/**
 * Splits a `git diff` into one entry per file. Lines are counted only inside hunks, so `---` and
 * `+++` headers never count. When `truncated`, the last file is the one the cut fell in.
 */
export function splitPatch(patch: string, truncated = false): DiffFile[] {
  const files: DiffFile[] = [];
  let current: (DiffFile & { inHunk: boolean; lines: string[] }) | null = null;
  const finish = () => {
    if (!current) return;
    const { inHunk: _inHunk, lines, ...file } = current;
    files.push({ ...file, patch: lines.join("\n") });
    current = null;
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finish();
      const paths = gitHeaderPaths(line);
      current = {
        path: paths?.[1] ?? "",
        oldPath: paths?.[0] ?? null,
        status: "modified",
        binary: false,
        additions: 0,
        deletions: 0,
        patch: "",
        truncated: false,
        inHunk: false,
        lines: [],
      };
      continue;
    }
    if (!current) continue;
    const file: DiffFile & { inHunk: boolean; lines: string[] } = current;
    if (line.startsWith("@@")) {
      file.inHunk = true;
      file.lines.push(line);
      continue;
    }
    if (file.inHunk) {
      if (line.startsWith("+")) file.additions += 1;
      else if (line.startsWith("-")) file.deletions += 1;
      file.lines.push(line);
      continue;
    }
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) file.path = line.slice("rename to ".length);
    else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file.binary = true;
    } else if (line.startsWith("--- ")) {
      const path = headerPath(line.slice(4));
      if (path && file.status !== "renamed") file.oldPath = path;
    } else if (line.startsWith("+++ ")) {
      const path = headerPath(line.slice(4));
      if (path) file.path = path;
    }
  }
  finish();
  for (const file of files) {
    if (file.status === "deleted" && !file.path) file.path = file.oldPath ?? "";
    if (file.status !== "renamed") file.oldPath = null;
  }
  const last = files.at(-1);
  if (truncated && last) last.truncated = true;
  return files.filter((f) => f.path);
}

/* ------------------------------------------------------------------------------------------ */
/* API read models                                                                             */
/* ------------------------------------------------------------------------------------------ */

/** Who produced a ChangeSet: the agent, its role, the Task, and the Intent summary. */
export const ChangeSetAttribution = z.object({
  id: z.string(),
  changeId: z.string(),
  agentId: z.string(),
  agentRole: z.string().nullable(),
  taskId: z.string().nullable(),
  taskKey: z.string().nullable(),
  taskTitle: z.string().nullable(),
  summary: z.string(),
  status: z.string(),
  /** Files this ChangeSet changed itself (its own files when it was stacked). */
  files: z.array(z.string()),
  /** A patch was stored at publish. False for ChangeSets published before patches existed. */
  patchRecorded: z.boolean(),
  createdAt: z.string(),
});
export type ChangeSetAttribution = z.infer<typeof ChangeSetAttribution>;

/** A stored patch, split per file. `recorded` is false when no patch exists (older records). */
export const CodeDiff = z.object({
  recorded: z.boolean(),
  base: z.string().nullable(),
  head: z.string().nullable(),
  /** Size of the full `git diff`, before truncation. */
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  files: z.array(
    DiffFile.extend({
      /** ChangeSets whose files include this path (Candidate diffs only). */
      changeSetIds: z.array(z.string()),
    }),
  ),
});
export type CodeDiff = z.infer<typeof CodeDiff>;

export const ChangeSetDiffView = z.object({
  changeSet: ChangeSetAttribution,
  diff: CodeDiff,
});

export const CandidateDiffView = z.object({
  candidateId: z.string(),
  changeId: z.string(),
  baseGeneration: z.number().int(),
  composedCommit: z.string().nullable(),
  changeSets: z.array(ChangeSetAttribution),
  diff: CodeDiff,
});

export const CodeTreeView = z.object({
  kind: z.literal("tree"),
  treeSha: z.string(),
  commit: z.string().nullable(),
  /** The tree is the live canonical tree. */
  live: z.boolean(),
  /** `partial` while blobs are still being copied; `missing` when no manifest exists yet. */
  contents: z.enum(["complete", "partial", "missing"]),
  files: z.array(
    z.object({ path: z.string(), size: z.number().int().nullable(), stored: z.boolean() }),
  ),
});

export const CodeFileView = z.object({
  kind: z.literal("file"),
  treeSha: z.string(),
  commit: z.string().nullable(),
  live: z.boolean(),
  path: z.string(),
  blob: z.string(),
  size: z.number().int().nullable(),
  binary: z.boolean(),
  /** Text content; null for binary, too large, or not yet stored files. */
  content: z.string().nullable(),
  /** Why `content` is null, when it is. */
  unavailable: z.enum(["binary", "too_large", "not_stored"]).nullable(),
});

export const CodeView = z.discriminatedUnion("kind", [CodeTreeView, CodeFileView]);

/** One Canonical Generation, newest first in `CodeVersions`. */
export const CodeVersion = z.object({
  generation: z.number().int().nonnegative(),
  treeSha: z.string().nullable(),
  commit: z.string().nullable(),
  live: z.boolean(),
  /** When the generation was promoted (or the Project was created, for S0). */
  at: z.string().nullable(),
  change: z.object({ id: z.string(), goal: z.string() }).nullable(),
  candidateId: z.string().nullable(),
  changeSets: z.array(ChangeSetAttribution),
});

export const CodeVersions = z.object({
  liveGeneration: z.number().int().nonnegative(),
  versions: z.array(CodeVersion),
  /** Older generations exist than `versions` lists. */
  truncated: z.boolean(),
});
