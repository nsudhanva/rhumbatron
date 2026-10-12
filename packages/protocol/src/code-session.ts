import { z } from "zod";
import { utf8Length } from "./code.ts";
import { MAX_EDIT_BYTES, normalizeEditPath } from "./code-edit.ts";

/**
 * Code page edit sessions (ADR 0029). The owner or an admin (`can(role, "code.edit")`) opens one
 * session per Project. The session forks canonical into the Artifacts repo `edit-<hex>`, keeps
 * the edits of the person, and runs terminal commands in the Project Sandbox. Submit turns every
 * edit into one Change with one human ChangeSet: the same path as a single-file code edit
 * (`code-edit.ts`). Only verified evidence advances the Canonical State.
 */

/** A session ends after this time without a request. */
export const CODE_SESSION_IDLE_MS = 10 * 60_000;
/** A session ends this long after it opened, used or not. */
export const CODE_SESSION_MAX_MS = 2 * 60 * 60_000;
/** Hard timeout of one terminal command. */
export const CODE_EXEC_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_CHARS = 2000;
/** Each output stream of a command is cut to its last 64 KB. */
export const MAX_EXEC_STREAM_BYTES = 64 * 1024;
/** Changed paths one session can hold. A command that changes more files imports none of them. */
export const MAX_SESSION_FILES = 200;

const SESSION_ID = /^edit_[a-f0-9]{32}$/;
export const CodeSessionId = z.string().regex(SESSION_ID);

/** True for a session ID of the shape `edit_<32 hex>`. Repo names derive only from such IDs. */
export const isCodeSessionId = (id: string) => SESSION_ID.test(id);

/** The Artifacts fork of a session: `edit-<hex>` for session `edit_<hex>`. */
export const codeSessionRepo = (sessionId: string) => `edit-${sessionId.slice(5)}`;

export const CodeSessionStatus = z.enum(["open", "submitted", "closed", "expired"]);
export type CodeSessionStatus = z.infer<typeof CodeSessionStatus>;

/** Why a session ended (`code.session.closed`). */
export const CodeSessionCloseReason = z.enum(["discarded", "idle", "max_age", "archived"]);
export type CodeSessionCloseReason = z.infer<typeof CodeSessionCloseReason>;

/* ------------------------------------------------------------------------------------------ */
/* Expiry                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * The expiry decision for one session at `now` (epoch ms). `expiresAt` is the earlier of the idle
 * limit (`lastUsedAt` + 10 minutes) and the 2-hour limit. A session at exactly its limit is
 * expired: a request never extends a session that already ended.
 */
export function sessionExpiry(
  session: { lastUsedAt: string; hardExpiresAt: string },
  now: number,
): { expired: false; expiresAt: string } | { expired: true; reason: "idle" | "max_age" } {
  const idleEnd = Date.parse(session.lastUsedAt) + CODE_SESSION_IDLE_MS;
  const hardEnd = Date.parse(session.hardExpiresAt);
  if (!Number.isFinite(idleEnd) || !Number.isFinite(hardEnd)) {
    return { expired: true, reason: "max_age" };
  }
  if (now >= hardEnd) return { expired: true, reason: "max_age" };
  if (now >= idleEnd) return { expired: true, reason: "idle" };
  return { expired: false, expiresAt: new Date(Math.min(idleEnd, hardEnd)).toISOString() };
}

/* ------------------------------------------------------------------------------------------ */
/* Paths, content, commands                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * A working directory for a command, relative to the session checkout: empty for the root, else a
 * repository path (`normalizeEditPath`). Null when invalid.
 */
export function normalizeCwd(cwd: string | undefined): string | null {
  const trimmed = (cwd ?? "").trim().replace(/\/+$/, "");
  if (trimmed === "" || trimmed === ".") return "";
  return normalizeEditPath(trimmed);
}

/** Why file content cannot go into a session, or null when it can. */
export function contentRefusal(content: string): "too_large" | "binary" | null {
  if (utf8Length(content) > MAX_EDIT_BYTES) return "too_large";
  if (content.includes("\u0000")) return "binary";
  return null;
}

/** Single-quotes a string for POSIX `sh` and `bash`. Nothing inside it is expanded. */
export const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * Keeps the last `max` UTF-8 bytes of one output stream. The cut never splits a character.
 */
export function tailBytes(
  text: string,
  max = MAX_EXEC_STREAM_BYTES,
): { text: string; cut: boolean } {
  if (utf8Length(text) <= max) return { text, cut: false };
  let start = text.length;
  let used = 0;
  while (start > 0) {
    const code = text.charCodeAt(start - 1);
    const low = code >= 0xdc00 && code <= 0xdfff && start > 1;
    const width = low ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (used + width > max) break;
    used += width;
    start -= low ? 2 : 1;
  }
  return { text: text.slice(start), cut: true };
}

/* ------------------------------------------------------------------------------------------ */
/* Requests                                                                                    */
/* ------------------------------------------------------------------------------------------ */

const Path = z.string().min(1).max(1024);

/** `PUT /v1/code/sessions/:sessionId/file`. Size and text checks are in `contentRefusal`. */
export const CodeSessionWriteRequest = z.object({ path: Path, content: z.string() });
export type CodeSessionWriteRequest = z.infer<typeof CodeSessionWriteRequest>;

/** `POST /v1/code/sessions/:sessionId/rename`. */
export const CodeSessionRenameRequest = z.object({ from: Path, to: Path });
export type CodeSessionRenameRequest = z.infer<typeof CodeSessionRenameRequest>;

/** `POST /v1/code/sessions/:sessionId/exec`. */
export const CodeSessionExecRequest = z.object({
  command: z.string().trim().min(1).max(MAX_COMMAND_CHARS),
  cwd: z.string().max(1024).optional(),
});
export type CodeSessionExecRequest = z.infer<typeof CodeSessionExecRequest>;

/** `POST /v1/code/sessions/:sessionId/submit`. */
export const CodeSessionSubmitRequest = z.object({
  message: z.string().trim().min(1).max(200),
  /** Display name from the sign-in session, for "edited by". Never used for authority. */
  authorName: z.string().trim().max(80).optional(),
});
export type CodeSessionSubmitRequest = z.infer<typeof CodeSessionSubmitRequest>;

/* ------------------------------------------------------------------------------------------ */
/* Responses                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/** `POST /v1/projects/:projectId/code/sessions` response data. */
export const CodeSessionView = z.object({
  sessionId: CodeSessionId,
  projectId: z.string(),
  baseGeneration: z.number().int().nonnegative(),
  baseCommit: z.string(),
  baseTree: z.string(),
  createdAt: z.string(),
  /** The earlier of the idle limit and the 2-hour limit. The web warns 1 minute before. */
  expiresAt: z.string(),
  /** The 2-hour limit. */
  hardExpiresAt: z.string(),
  idleTimeoutMs: z.number().int().positive(),
  /** Paths written, added, or deleted in this session, sorted. */
  changedFiles: z.array(z.string()),
});
export type CodeSessionView = z.infer<typeof CodeSessionView>;

export const CodeSessionFile = z.object({
  path: z.string(),
  /** Bytes. Null for a base file whose size the code store does not know yet. */
  size: z.number().int().nonnegative().nullable(),
  changed: z.boolean(),
});
export type CodeSessionFile = z.infer<typeof CodeSessionFile>;

/** `GET /v1/code/sessions/:sessionId`: the session plus the file tree of its fork with the edits. */
export const CodeSessionDetail = CodeSessionView.extend({
  files: z.array(CodeSessionFile),
  /** Paths deleted in this session (not in `files`). */
  deletedFiles: z.array(z.string()),
});
export type CodeSessionDetail = z.infer<typeof CodeSessionDetail>;

export const CodeSessionFileContent = z.object({
  path: z.string(),
  content: z.string(),
  size: z.number().int().nonnegative(),
  encoding: z.literal("utf8"),
  changed: z.boolean(),
});
export type CodeSessionFileContent = z.infer<typeof CodeSessionFileContent>;

/** Result of a file write, delete, or rename. */
export const CodeSessionEdit = z.object({
  changedFiles: z.array(z.string()),
  expiresAt: z.string(),
});
export type CodeSessionEdit = z.infer<typeof CodeSessionEdit>;

export const CodeSessionExecResult = z.object({
  /** 124 when the command reached the 120 s timeout (as GNU `timeout`). */
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
  /** A stream was cut to its last 64 KB. */
  truncated: z.boolean(),
  timedOut: z.boolean(),
  /** Paths changed in the session after the command, sorted. */
  changedFiles: z.array(z.string()),
  expiresAt: z.string(),
});
export type CodeSessionExecResult = z.infer<typeof CodeSessionExecResult>;

export const CodeSessionSubmitResult = z.object({
  changeId: z.string(),
  changeSetId: z.string(),
  candidateIds: z.array(z.string()),
  /** `created` for a new Change; `existing` when a repeated submit found it. */
  status: z.enum(["created", "existing"]),
});
export type CodeSessionSubmitResult = z.infer<typeof CodeSessionSubmitResult>;

/** The session ended: `DELETE /v1/code/sessions/:sessionId`. A repeat is safe. */
export const CodeSessionClosed = z.object({ sessionId: z.string(), status: CodeSessionStatus });
export type CodeSessionClosed = z.infer<typeof CodeSessionClosed>;

/* ------------------------------------------------------------------------------------------ */
/* Integration Worker outcomes                                                                 */
/* ------------------------------------------------------------------------------------------ */

export const CodeSessionRefusalReason = z.enum([
  "not_found",
  /** The session reached the idle or the 2-hour limit; its edits are discarded. */
  "expired",
  /** The session was submitted or discarded. */
  "closed",
  "archived",
  "no_source",
  "invalid_path",
  "not_a_file",
  "exists",
  "binary",
  "too_large",
  "too_many_files",
  "no_change",
  /** Canonical advanced and changed a file that this session also changed. */
  "stale_base",
  /** A command runs in this session. */
  "busy",
  /** The monthly Sandbox seconds are used up (`SANDBOX_MONTHLY_SECONDS`). */
  "sandbox_cap",
  /**
   * The Sandbox did not start or did not answer in time. One Sandbox container runs for the whole
   * account, so the terminal waits while agents or Candidate checks use it for another Project.
   */
  "sandbox_busy",
  /** The Sandbox cannot run the command as an unprivileged user, or it failed, so it runs nothing. */
  "sandbox_unavailable",
]);
export type CodeSessionRefusalReason = z.infer<typeof CodeSessionRefusalReason>;

export const CodeSessionRefused = z.object({
  status: z.literal("refused"),
  reason: CodeSessionRefusalReason,
  detail: z.string(),
});
export type CodeSessionRefused = z.infer<typeof CodeSessionRefused>;

/** Every session RPC returns its data, or a refusal. */
export const codeSessionOutcome = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion("status", [z.object({ status: z.literal("ok"), data }), CodeSessionRefused]);

/** HTTP status of a refused session request. */
export function sessionRefusalStatus(
  reason: CodeSessionRefusalReason,
): 400 | 404 | 409 | 410 | 413 | 415 | 429 | 503 {
  switch (reason) {
    case "not_found":
    case "not_a_file":
      return 404;
    case "expired":
    case "closed":
      return 410;
    case "archived":
    case "no_source":
    case "exists":
    case "no_change":
    case "stale_base":
    case "busy":
      return 409;
    case "too_large":
    case "too_many_files":
      return 413;
    case "binary":
      return 415;
    case "sandbox_cap":
      return 429;
    case "sandbox_busy":
    case "sandbox_unavailable":
      return 503;
    default:
      return 400;
  }
}
