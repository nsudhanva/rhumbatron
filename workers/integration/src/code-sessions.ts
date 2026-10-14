import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import type { ProjectRootDO, ResourceShardDO } from "@rhumbatron/coordinator";
import { shardKey } from "@rhumbatron/coordinator/shard-key";
import {
  CODE_EXEC_TIMEOUT_MS,
  CODE_SESSION_IDLE_MS,
  CODE_SESSION_MAX_MS,
  type CodeEntry,
  CodeManifest,
  type CodeSessionClosed,
  type CodeSessionCloseReason,
  type CodeSessionDetail,
  type CodeSessionEdit,
  type CodeSessionExecResult,
  type CodeSessionFileContent,
  type CodeSessionRefusalReason,
  type CodeSessionRefused,
  type CodeSessionStatus,
  type CodeSessionSubmitResult,
  type CodeSessionView,
  codeBlobKey,
  codeManifestKey,
  codeSessionRepo,
  contentRefusal,
  type EventEnvelope,
  type EventType,
  isCodeSessionId,
  MAX_EDIT_BYTES,
  MAX_SESSION_FILES,
  normalizeCwd,
  normalizeEditPath,
  sessionExpiry,
  shellQuote,
  tailBytes,
} from "@rhumbatron/protocol";
import { backfillTreeCode, walkTree } from "./code-store.ts";
import { stableEventId } from "./events.ts";
import {
  baseCommitFor,
  changeIdFor,
  existingHumanChange,
  type HumanFileOp,
  recordHumanChange,
} from "./human-edit.ts";
import {
  reserveSandboxSeconds,
  SANDBOX_SLEEP_TAIL_SECONDS,
  settleSandboxUse,
} from "./sandbox-meter.ts";

/**
 * Code page edit sessions (ADR 0029). The owner or an admin opens
 * one session per Project. The API checked `can(role, "code.edit")` and that the caller owns the
 * session; every function here checks the owner again, and the session state, from D1.
 *
 * - Source: the session forks canonical into `edit-<hex>`. Edits live in D1
 *   (`code_session_files`), not in the Sandbox: the Sandbox sleeps after 2 idle minutes and loses
 *   its disk, a session lives up to 10 idle minutes. Reads come from the edits, else from the code
 *   store of the base tree (R2), else from Artifacts.
 * - Terminal: the first command starts the Project Sandbox (`proj-<uuid>`, the one instance that
 *   agents and Candidate checks use). The checkout is `/workspace/edit-<hex>`. Before a command the
 *   checkout is reset to base plus the edits when the edits changed; after it, every changed file
 *   becomes a session edit. Commands run as an unprivileged user with no token and no secret in
 *   their environment, so they cannot change agent or Candidate checkouts or read their tokens.
 * - Meter: each command reserves Sandbox seconds on `usage_counters` (`sandbox-seconds`, the
 *   `SANDBOX_MONTHLY_SECONDS` cap) and settles to the awake time it added. At the cap: refused.
 * - Submit: one Change with one human ChangeSet (`recordHumanChange`), then the session ends.
 * - End: discard, submit, the idle limit, the 2-hour limit, or an archived Project. The fork and
 *   the edits are deleted. The Sandbox directory is removed only while the Sandbox is still awake.
 */

/** Idle time billed after the last command, until the Sandbox sleeps. */
const SLEEP_TAIL_SECONDS = SANDBOX_SLEEP_TAIL_SECONDS;
/** Checkout setup (clone, install) plus the command timeout plus the idle tail, rounded up. */
const EXEC_RESERVATION_SECONDS = 480;
const SETUP_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 60_000;
/** A command lock older than this is from a lost request. */
const EXEC_LOCK_MS = 7 * 60_000;
/** Overdue sessions closed per sweep call. */
const SWEEP_LIMIT = 50;
const SHA = /^[0-9a-f]{40}$/;

type SessionEnv = Env;

type SessionRow = {
  id: string;
  project_id: string;
  user_id: string;
  base_generation: number;
  base_commit: string;
  base_tree: string;
  repo: string;
  status: CodeSessionStatus;
  revision: number;
  exec_started_at: string | null;
  sandbox_awake_until: number | null;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  change_id: string | null;
  fork_deleted_at: string | null;
  org_id: string;
  project_status: string;
};

type FileRow = { path: string; state: "written" | "deleted"; size: number; blob: string | null };

export type SessionOutcome<T> = { status: "ok"; data: T } | CodeSessionRefused;

const ok = <T>(data: T): SessionOutcome<T> => ({ status: "ok", data });
const refuse = (reason: CodeSessionRefusalReason, detail: string): CodeSessionRefused => ({
  status: "refused",
  reason,
  detail,
});

const SESSION_SQL = `SELECT s.*, p.org_id, p.status AS project_status
  FROM code_sessions s JOIN projects p ON p.id = s.project_id`;

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The Git blob ID of text content: `sha1("blob <bytes>\0" + bytes)`. */
async function gitBlobId(content: string): Promise<string> {
  const body = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${body.length}\u0000`);
  const all = new Uint8Array(header.length + body.length);
  all.set(header);
  all.set(body, header.length);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-1", all)));
}

/* ------------------------------------------------------------------------------------------ */
/* Sandbox meter                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** Reserves seconds on the shared monthly Sandbox meter (sandbox-meter.ts). False at the cap. */
export const reserveSessionSeconds = (
  db: D1Database,
  seconds: number,
  configuredMonthlySeconds?: string,
) => reserveSandboxSeconds(db, seconds, configuredMonthlySeconds);

/**
 * Seconds one command adds to the Sandbox awake time: from its start (or the end of the time
 * already billed) to its end plus the idle tail. Commands within one tail overlap, so the
 * overlap is billed once.
 */
export function awakeSeconds(input: {
  startedAt: number;
  endedAt: number;
  awakeUntil: number | null;
}): { seconds: number; awakeUntil: number } {
  const awakeUntil = input.endedAt + SLEEP_TAIL_SECONDS * 1000;
  const from = Math.max(input.startedAt, input.awakeUntil ?? 0);
  return { seconds: Math.max(0, Math.ceil((awakeUntil - from) / 1000)), awakeUntil };
}

/* ------------------------------------------------------------------------------------------ */
/* Rows, expiry, events                                                                        */
/* ------------------------------------------------------------------------------------------ */

const isoNow = (now: number) => new Date(now).toISOString();

function viewOf(row: SessionRow, changed: string[], now: number): CodeSessionView {
  const expiry = sessionExpiry(
    { lastUsedAt: row.last_used_at, hardExpiresAt: row.expires_at },
    now,
  );
  return {
    sessionId: row.id,
    projectId: row.project_id,
    baseGeneration: row.base_generation,
    baseCommit: row.base_commit,
    baseTree: row.base_tree,
    createdAt: row.created_at,
    expiresAt: expiry.expired ? isoNow(now) : expiry.expiresAt,
    hardExpiresAt: row.expires_at,
    idleTimeoutMs: CODE_SESSION_IDLE_MS,
    changedFiles: [...changed].sort(),
  };
}

async function sessionEvent(
  env: SessionEnv,
  row: SessionRow,
  eventType: EventType,
  payload: Record<string, unknown>,
  actor: EventEnvelope["actor"],
) {
  // Project cleanup purges the shards last; an event after it would fill a shard again.
  if (row.project_status === "archived") return;
  const event: EventEnvelope = {
    eventId: await stableEventId(row.id, eventType),
    eventType,
    eventVersion: 1,
    tenantId: row.org_id,
    projectId: row.project_id,
    ...(typeof payload.changeId === "string" ? { changeId: payload.changeId } : {}),
    actor,
    canonicalGeneration: row.base_generation,
    correlationId: row.id,
    timestamp: new Date().toISOString(),
    payload: { sessionId: row.id, ...payload },
  };
  try {
    const ns = env.RESOURCE_SHARD as DurableObjectNamespace<ResourceShardDO>;
    await ns
      .get(ns.idFromName(shardKey(row.project_id, `code-session:${row.id}`)))
      .appendEvents([event]);
  } catch (error) {
    // The session state in D1 is the truth; the event is the record for the feed and analytics.
    console.warn(
      JSON.stringify({
        event: "code_session.event_failed",
        eventType,
        error: String(error).slice(0, 200),
      }),
    );
  }
}

const sessionDir = (sessionId: string) => `/workspace/${codeSessionRepo(sessionId)}`;

const sandboxFor = (env: SessionEnv, projectId: string) =>
  getSandbox(
    env.SANDBOX as unknown as DurableObjectNamespace<Sandbox>,
    `proj-${projectId.slice(5)}`,
    { sleepAfter: "2m" },
  );

/**
 * Ends a session: status, the Sandbox directory (only while the Sandbox is awake: a sleeping
 * Sandbox has no disk, and waking it only to clean it spends Sandbox hours), the fork, and the
 * edits. Safe to repeat: a session that already ended only retries a fork delete that failed.
 */
async function endSession(
  env: SessionEnv,
  row: SessionRow,
  status: Exclude<CodeSessionStatus, "open">,
  reason: CodeSessionCloseReason | null,
  extra: { changeId?: string; actorUserId?: string } = {},
) {
  const now = Date.now();
  const ended = await env.DB.prepare(
    `UPDATE code_sessions SET status = ?, close_reason = ?, closed_at = ?, exec_started_at = NULL,
       change_id = COALESCE(?, change_id)
     WHERE id = ? AND status = 'open'`,
  )
    .bind(
      status,
      status === "submitted" ? "submitted" : reason,
      isoNow(now),
      extra.changeId ?? null,
      row.id,
    )
    .run();
  if (row.sandbox_awake_until && row.sandbox_awake_until > now) {
    const dir = sessionDir(row.id);
    try {
      await run(
        sandboxFor(env, row.project_id),
        `${killSessionProcesses(row.id)} ; rm -rf ${dir} ${dir}.home ${dir}.rev`,
        { timeoutMs: GIT_TIMEOUT_MS },
      );
      // The call keeps the Sandbox awake for another idle tail.
      await settleSandboxUse(env.DB, {
        projectId: row.project_id,
        startedAt: now,
        endedAt: now,
        reservedSeconds: 0,
      });
    } catch {
      // A lost or sleeping Sandbox already dropped the directory.
    }
  }
  if (!row.fork_deleted_at && isCodeSessionId(row.id)) {
    try {
      await env.ARTIFACTS.delete(codeSessionRepo(row.id));
      await env.DB.prepare("UPDATE code_sessions SET fork_deleted_at = ? WHERE id = ?")
        .bind(isoNow(Date.now()), row.id)
        .run();
    } catch (error) {
      // The daily sweep retries (`fork_deleted_at` stays NULL).
      console.warn(
        JSON.stringify({
          event: "code_session.fork_delete_failed",
          sessionId: row.id,
          error: String(error).slice(0, 200),
        }),
      );
    }
  }
  await env.DB.prepare("DELETE FROM code_session_files WHERE session_id = ?").bind(row.id).run();
  if ((ended.meta?.changes ?? 0) > 0) {
    const actor = extra.actorUserId
      ? { kind: "user" as const, id: extra.actorUserId }
      : { kind: "system" as const, id: "code-sessions" };
    if (status === "submitted") {
      await sessionEvent(env, row, "code.session.submitted", { changeId: extra.changeId }, actor);
    } else {
      await sessionEvent(env, row, "code.session.closed", { reason, status }, actor);
    }
  }
}

/**
 * The unprivileged user and group of one session's commands (20000 to 59999, no passwd entry is
 * needed): commands of two sessions in one Sandbox cannot touch each other's files or processes.
 */
function commandUid(sessionId: string): number {
  let hash = 2166136261;
  for (const ch of sessionId) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return 20_000 + ((hash >>> 0) % 40_000);
}

/**
 * A root shell command that kills every process of the session user. The kill runs as that user
 * (`kill -1` reaches every process the sender may signal, except itself), so it never reaches a
 * process of an agent, a Candidate check, or another session, and it needs no `procps` tools.
 */
function killSessionProcesses(sessionId: string): string {
  const uid = commandUid(sessionId);
  return `setpriv --reuid=${uid} --regid=${uid} --clear-groups --no-new-privs sh -c 'kill -s KILL -1' 2>/dev/null`;
}

/**
 * Loads an open session of `userId` and touches it. Refuses another user's session (as not
 * found), an ended session, and an expired one; an expired or archived one is ended here.
 */
async function loadOpen(
  env: SessionEnv,
  sessionId: string,
  userId: string,
  now: number,
  options: { touch?: boolean } = {},
): Promise<{ row: SessionRow } | CodeSessionRefused> {
  if (!isCodeSessionId(sessionId)) return refuse("not_found", "Session not found.");
  const row = await env.DB.prepare(`${SESSION_SQL} WHERE s.id = ?`)
    .bind(sessionId)
    .first<SessionRow>();
  if (!row || row.user_id !== userId) return refuse("not_found", "Session not found.");
  if (row.status === "expired") {
    return refuse("expired", "The session expired. Its edits were discarded.");
  }
  if (row.status !== "open") return refuse("closed", "The session has ended.");
  if (row.project_status === "archived") {
    await endSession(env, row, "closed", "archived");
    return refuse("archived", "Project is archived.");
  }
  const expiry = sessionExpiry(
    { lastUsedAt: row.last_used_at, hardExpiresAt: row.expires_at },
    now,
  );
  if (expiry.expired) {
    await endSession(env, row, "expired", expiry.reason);
    return refuse("expired", "The session expired. Its edits were discarded.");
  }
  if (options.touch !== false) {
    const used = isoNow(now);
    await env.DB.prepare(
      "UPDATE code_sessions SET last_used_at = ? WHERE id = ? AND status = 'open'",
    )
      .bind(used, row.id)
      .run();
    row.last_used_at = used;
  }
  return { row };
}

const commandRunning = (row: SessionRow, now: number) =>
  row.exec_started_at !== null && Date.parse(row.exec_started_at) > now - EXEC_LOCK_MS;

const BUSY = () => refuse("busy", "A command is running in this session. Wait for it to end.");

async function fileRows(env: SessionEnv, sessionId: string): Promise<FileRow[]> {
  const rows = await env.DB.prepare(
    "SELECT path, state, size, blob FROM code_session_files WHERE session_id = ? ORDER BY path",
  )
    .bind(sessionId)
    .all<FileRow>();
  return rows.results ?? [];
}

/* ------------------------------------------------------------------------------------------ */
/* Base tree                                                                                    */
/* ------------------------------------------------------------------------------------------ */

async function readManifest(env: SessionEnv, projectId: string, treeSha: string) {
  const object = await env.EVIDENCE.get(codeManifestKey(projectId, treeSha));
  if (!object) return null;
  const parsed = CodeManifest.safeParse(await object.json().catch(() => null));
  return parsed.success && parsed.data.treeSha === treeSha ? parsed.data : null;
}

/** Path to entry of a canonical tree: the code manifest, backfilled once, else a tree walk. */
async function treeEntries(
  env: SessionEnv,
  projectId: string,
  treeSha: string,
): Promise<Map<string, CodeEntry>> {
  let manifest = await readManifest(env, projectId, treeSha);
  if (!manifest) {
    await backfillTreeCode(env, { projectId, treeSha }).catch(() => null);
    manifest = await readManifest(env, projectId, treeSha);
  }
  let entries = manifest?.entries;
  if (!entries) {
    using repo = await env.ARTIFACTS.get(projectId);
    entries = await walkTree(repo, treeSha);
  }
  return new Map(entries.map((entry) => [entry.path, entry]));
}

/** Text of one base file, or why it cannot be edited here. */
async function readBaseText(
  env: SessionEnv,
  projectId: string,
  entry: CodeEntry,
): Promise<{ text: string; size: number } | CodeSessionRefused> {
  if (entry.size !== null && entry.size > MAX_EDIT_BYTES) {
    return refuse("too_large", `Files over ${MAX_EDIT_BYTES / 1024} KB cannot be edited here.`);
  }
  let bytes: Uint8Array | null = null;
  if (entry.stored) {
    const object = await env.EVIDENCE.get(codeBlobKey(projectId, entry.blob));
    if (object) bytes = new Uint8Array(await object.arrayBuffer());
  }
  if (!bytes) {
    using repo = await env.ARTIFACTS.get(projectId);
    const blob = await repo.readBlob(entry.blob);
    if (!blob) return refuse("not_a_file", `${entry.path} is not readable.`);
    if (blob.size > MAX_EDIT_BYTES) {
      return refuse("too_large", `Files over ${MAX_EDIT_BYTES / 1024} KB cannot be edited here.`);
    }
    bytes = new Uint8Array(await blob.arrayBuffer());
  }
  if (bytes.length > MAX_EDIT_BYTES) {
    return refuse("too_large", `Files over ${MAX_EDIT_BYTES / 1024} KB cannot be edited here.`);
  }
  if (bytes.includes(0)) return refuse("binary", "Only text files can be edited here.");
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      size: bytes.length,
    };
  } catch {
    return refuse("binary", "Only text files can be edited here.");
  }
}

/** The files of the session view: base files without deletions, plus written files. */
function sessionTree(
  base: ReadonlyMap<string, Pick<CodeEntry, "size">>,
  edits: readonly Pick<FileRow, "path" | "state" | "size">[],
): { files: { path: string; size: number | null; changed: boolean }[]; deleted: string[] } {
  const byPath = new Map(edits.map((e) => [e.path, e]));
  const files: { path: string; size: number | null; changed: boolean }[] = [];
  for (const [path, entry] of base) {
    const edit = byPath.get(path);
    if (edit?.state === "deleted") continue;
    files.push(
      edit ? { path, size: edit.size, changed: true } : { path, size: entry.size, changed: false },
    );
  }
  for (const edit of edits) {
    if (edit.state === "written" && !base.has(edit.path)) {
      files.push({ path: edit.path, size: edit.size, changed: true });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const deleted = edits.filter((e) => e.state === "deleted" && base.has(e.path)).map((e) => e.path);
  return { files, deleted: deleted.sort() };
}

/**
 * Why `path` cannot be a file next to the others: a folder with that name exists, or a parent of
 * it is a file. Null when the path is free to hold a file.
 */
function pathShapeConflict(path: string, existing: Iterable<string>): string | null {
  const parents = new Set<string>();
  for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1))
    parents.add(path.slice(0, i));
  for (const other of existing) {
    if (other.startsWith(`${path}/`)) return `${path} is a folder.`;
    if (parents.has(other)) return `${other} is a file, not a folder.`;
  }
  return null;
}

/* ------------------------------------------------------------------------------------------ */
/* Open, read, close                                                                           */
/* ------------------------------------------------------------------------------------------ */

/**
 * Opens the caller's session, or returns the open one (one per user per Project). Forks the
 * canonical tree; no Sandbox starts. The API checked `code.edit`.
 */
export async function openCodeSession(
  env: SessionEnv,
  input: { projectId: string; userId: string },
): Promise<SessionOutcome<CodeSessionView>> {
  const now = Date.now();
  const project = await env.DB.prepare("SELECT status FROM projects WHERE id = ?")
    .bind(input.projectId)
    .first<{ status: string }>();
  if (!project) return refuse("not_found", "Project not found.");
  if (project.status === "archived") return refuse("archived", "Project is archived.");
  await expireCodeSessions(env, { now, projectId: input.projectId });

  const findOpen = () =>
    env.DB.prepare(`${SESSION_SQL} WHERE s.project_id = ? AND s.user_id = ? AND s.status = 'open'`)
      .bind(input.projectId, input.userId)
      .first<SessionRow>();
  const current = await findOpen();
  if (current) {
    const loaded = await loadOpen(env, current.id, input.userId, now);
    if ("row" in loaded) {
      return ok(
        viewOf(
          loaded.row,
          (await fileRows(env, current.id)).map((f) => f.path),
          now,
        ),
      );
    }
  }

  const root = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  const canonical = await root.get(root.idFromName(input.projectId)).getCanonical();
  if (!canonical || canonical.artifactRef === "unassigned") {
    return refuse("no_source", "The project has no source to edit.");
  }
  const baseCommit = await baseCommitFor(env, input.projectId, canonical.treeSha);
  const sessionId = `edit_${crypto.randomUUID().replace(/-/g, "")}`;
  const repo = codeSessionRepo(sessionId);
  const created = isoNow(now);
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO code_sessions (id, project_id, user_id, base_generation, base_commit,
       base_tree, repo, status, revision, created_at, last_used_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?)`,
  )
    .bind(
      sessionId,
      input.projectId,
      input.userId,
      canonical.generation,
      baseCommit,
      canonical.treeSha,
      repo,
      created,
      created,
      isoNow(now + CODE_SESSION_MAX_MS),
    )
    .run();
  if ((inserted.meta?.changes ?? 0) === 0) {
    // A concurrent open of the same user won the unique index: return that session.
    const winner = await findOpen();
    if (!winner) throw new Error("code session insert ignored without an open session");
    return ok(viewOf(winner, [], now));
  }
  const row = await env.DB.prepare(`${SESSION_SQL} WHERE s.id = ?`)
    .bind(sessionId)
    .first<SessionRow>();
  if (!row) throw new Error("code session row is missing after insert");
  try {
    using canonicalRepo = await env.ARTIFACTS.get(input.projectId);
    await canonicalRepo.fork(repo, {
      description: `Code edit session ${sessionId}`,
      defaultBranchOnly: true,
    });
  } catch (error) {
    await endSession(env, row, "closed", "discarded");
    throw error;
  }
  // The file list and reads come from the code store of the base tree.
  await backfillTreeCode(env, { projectId: input.projectId, treeSha: canonical.treeSha }).catch(
    () => null,
  );
  await sessionEvent(
    env,
    row,
    "code.session.opened",
    { baseGeneration: canonical.generation, baseTree: canonical.treeSha },
    { kind: "user", id: input.userId },
  );
  return ok(viewOf(row, [], now));
}

/** `GET /v1/code/sessions/:sessionId`: the session and the file tree with its edits. */
export async function getCodeSession(
  env: SessionEnv,
  input: { sessionId: string; userId: string },
): Promise<SessionOutcome<CodeSessionDetail>> {
  const now = Date.now();
  const loaded = await loadOpen(env, input.sessionId, input.userId, now);
  if (!("row" in loaded)) return loaded;
  const { row } = loaded;
  const [base, edits] = await Promise.all([
    treeEntries(env, row.project_id, row.base_tree),
    fileRows(env, row.id),
  ]);
  const tree = sessionTree(base, edits);
  return ok({
    ...viewOf(
      row,
      edits.map((e) => e.path),
      now,
    ),
    files: tree.files,
    deletedFiles: tree.deleted,
  });
}

/** One file of the session: its edit, else the base file. Binary and over 256 KB are refused. */
export async function readCodeSessionFile(
  env: SessionEnv,
  input: { sessionId: string; userId: string; path: string },
): Promise<SessionOutcome<CodeSessionFileContent>> {
  const loaded = await loadOpen(env, input.sessionId, input.userId, Date.now());
  if (!("row" in loaded)) return loaded;
  const { row } = loaded;
  const path = normalizeEditPath(input.path);
  if (!path) return refuse("invalid_path", "The path is not a file in this repository.");
  const edit = await env.DB.prepare(
    "SELECT state, content, size FROM code_session_files WHERE session_id = ? AND path = ?",
  )
    .bind(row.id, path)
    .first<{ state: string; content: string | null; size: number }>();
  if (edit?.state === "deleted")
    return refuse("not_a_file", `${path} was deleted in this session.`);
  if (edit) {
    return ok({
      path,
      content: edit.content ?? "",
      size: edit.size,
      encoding: "utf8",
      changed: true,
    });
  }
  const entry = (await treeEntries(env, row.project_id, row.base_tree)).get(path);
  if (!entry) return refuse("not_a_file", `${path} is not a file in this session.`);
  const read = await readBaseText(env, row.project_id, entry);
  if ("status" in read) return read;
  return ok({ path, content: read.text, size: read.size, encoding: "utf8", changed: false });
}

/** Discards the session: the fork, the edits, and the Sandbox directory go. A repeat is safe. */
export async function closeCodeSession(
  env: SessionEnv,
  input: { sessionId: string; userId: string },
): Promise<SessionOutcome<CodeSessionClosed>> {
  if (!isCodeSessionId(input.sessionId)) return refuse("not_found", "Session not found.");
  const row = await env.DB.prepare(`${SESSION_SQL} WHERE s.id = ?`)
    .bind(input.sessionId)
    .first<SessionRow>();
  if (!row || row.user_id !== input.userId) return refuse("not_found", "Session not found.");
  if (row.status !== "open") return ok({ sessionId: row.id, status: row.status });
  await endSession(env, row, "closed", "discarded", { actorUserId: input.userId });
  return ok({ sessionId: row.id, status: "closed" });
}

/**
 * Ends overdue open sessions (idle 10 minutes, or 2 hours old): the daily maintenance sweep for
 * all Projects, and each open for one Project. It also retries fork deletes that failed.
 */
export async function expireCodeSessions(
  env: SessionEnv,
  input: { now: number; projectId?: string },
): Promise<{ expired: number; forksRetried: number }> {
  const idleCutoff = isoNow(input.now - CODE_SESSION_IDLE_MS);
  const nowIso = isoNow(input.now);
  const scope = input.projectId ? " AND s.project_id = ?" : "";
  const bind = (statement: D1PreparedStatement, ...values: unknown[]) =>
    statement.bind(...values, ...(input.projectId ? [input.projectId] : []), SWEEP_LIMIT);
  const [overdue, leftover] = await env.DB.batch<SessionRow>([
    bind(
      env.DB.prepare(
        `${SESSION_SQL} WHERE s.status = 'open' AND (s.last_used_at < ? OR s.expires_at <= ?)${scope}
         ORDER BY s.last_used_at LIMIT ?`,
      ),
      idleCutoff,
      nowIso,
    ),
    bind(
      env.DB.prepare(
        `${SESSION_SQL} WHERE s.status != 'open' AND s.fork_deleted_at IS NULL${scope}
         ORDER BY s.closed_at LIMIT ?`,
      ),
    ),
  ]);
  let expired = 0;
  for (const row of overdue?.results ?? []) {
    const expiry = sessionExpiry(
      { lastUsedAt: row.last_used_at, hardExpiresAt: row.expires_at },
      input.now,
    );
    if (!expiry.expired) continue;
    await endSession(env, row, "expired", expiry.reason);
    expired += 1;
  }
  const retried = leftover?.results ?? [];
  for (const row of retried)
    await endSession(env, row, row.status === "open" ? "closed" : row.status, null);
  return { expired, forksRetried: retried.length };
}

/* ------------------------------------------------------------------------------------------ */
/* Edits                                                                                       */
/* ------------------------------------------------------------------------------------------ */

type EditContext = {
  row: SessionRow;
  base: Map<string, CodeEntry>;
  edits: Map<string, FileRow>;
};

async function editContext(
  env: SessionEnv,
  input: { sessionId: string; userId: string },
  now: number,
): Promise<EditContext | CodeSessionRefused> {
  const loaded = await loadOpen(env, input.sessionId, input.userId, now);
  if (!("row" in loaded)) return loaded;
  if (commandRunning(loaded.row, now)) return BUSY();
  const [base, edits] = await Promise.all([
    treeEntries(env, loaded.row.project_id, loaded.row.base_tree),
    fileRows(env, loaded.row.id),
  ]);
  return { row: loaded.row, base, edits: new Map(edits.map((e) => [e.path, e])) };
}

/** True when `path` is a file of the session now. */
const exists = (ctx: EditContext, path: string) => {
  const edit = ctx.edits.get(path);
  return edit ? edit.state === "written" : ctx.base.has(path);
};

/** Every file path of the session now (base files not deleted, plus written files). */
function livePaths(ctx: EditContext): string[] {
  return sessionTree(ctx.base, [...ctx.edits.values()]).files.map((f) => f.path);
}

/** The D1 statement that makes `path` hold `content`: an upsert, or a delete when it equals base. */
async function writeStatement(
  env: SessionEnv,
  ctx: EditContext,
  path: string,
  content: string,
  now: number,
) {
  const blob = await gitBlobId(content);
  if (ctx.base.get(path)?.blob === blob) {
    return env.DB.prepare("DELETE FROM code_session_files WHERE session_id = ? AND path = ?").bind(
      ctx.row.id,
      path,
    );
  }
  return env.DB.prepare(
    `INSERT INTO code_session_files (session_id, path, state, content, size, blob, updated_at)
     VALUES (?, ?, 'written', ?, ?, ?, ?)
     ON CONFLICT (session_id, path) DO UPDATE SET state = 'written', content = excluded.content,
       size = excluded.size, blob = excluded.blob, updated_at = excluded.updated_at`,
  ).bind(ctx.row.id, path, content, new TextEncoder().encode(content).length, blob, isoNow(now));
}

/** The D1 statement that deletes `path`: a `deleted` row for a base file, else no row. */
function deleteStatement(env: SessionEnv, ctx: EditContext, path: string, now: number) {
  if (!ctx.base.has(path)) {
    return env.DB.prepare("DELETE FROM code_session_files WHERE session_id = ? AND path = ?").bind(
      ctx.row.id,
      path,
    );
  }
  return env.DB.prepare(
    `INSERT INTO code_session_files (session_id, path, state, content, size, blob, updated_at)
     VALUES (?, ?, 'deleted', NULL, 0, NULL, ?)
     ON CONFLICT (session_id, path) DO UPDATE SET state = 'deleted', content = NULL, size = 0,
       blob = NULL, updated_at = excluded.updated_at`,
  ).bind(ctx.row.id, path, isoNow(now));
}

async function commitEdits(
  env: SessionEnv,
  ctx: EditContext,
  statements: D1PreparedStatement[],
  now: number,
) {
  await env.DB.batch([
    ...statements,
    env.DB.prepare("UPDATE code_sessions SET revision = revision + 1 WHERE id = ?").bind(
      ctx.row.id,
    ),
  ]);
  const edits = await fileRows(env, ctx.row.id);
  return ok<CodeSessionEdit>({
    changedFiles: edits.map((e) => e.path),
    expiresAt: viewOf(ctx.row, [], now).expiresAt,
  });
}

const tooMany = () =>
  refuse(
    "too_many_files",
    `A session can change at most ${MAX_SESSION_FILES} files. Submit or discard some first.`,
  );

/** Writes one file (create or update). 256 KB, text only, a path under the repository root. */
export async function writeCodeSessionFile(
  env: SessionEnv,
  input: { sessionId: string; userId: string; path: string; content: string },
): Promise<SessionOutcome<CodeSessionEdit>> {
  const now = Date.now();
  const path = normalizeEditPath(input.path);
  if (!path) return refuse("invalid_path", "The path is not a file in this repository.");
  const content = contentRefusal(input.content);
  if (content === "too_large") {
    return refuse("too_large", `Files over ${MAX_EDIT_BYTES / 1024} KB cannot be edited here.`);
  }
  if (content === "binary") return refuse("binary", "Only text files can be edited here.");
  const ctx = await editContext(env, input, now);
  if ("status" in ctx) return ctx;
  if (!exists(ctx, path)) {
    const shape = pathShapeConflict(path, livePaths(ctx));
    if (shape) return refuse("invalid_path", shape);
  }
  if (!ctx.edits.has(path) && ctx.edits.size >= MAX_SESSION_FILES) return tooMany();
  return commitEdits(env, ctx, [await writeStatement(env, ctx, path, input.content, now)], now);
}

/** Deletes one file of the session. */
export async function deleteCodeSessionFile(
  env: SessionEnv,
  input: { sessionId: string; userId: string; path: string },
): Promise<SessionOutcome<CodeSessionEdit>> {
  const now = Date.now();
  const path = normalizeEditPath(input.path);
  if (!path) return refuse("invalid_path", "The path is not a file in this repository.");
  const ctx = await editContext(env, input, now);
  if ("status" in ctx) return ctx;
  if (!exists(ctx, path)) return refuse("not_a_file", `${path} is not a file in this session.`);
  if (!ctx.edits.has(path) && ctx.edits.size >= MAX_SESSION_FILES) return tooMany();
  return commitEdits(env, ctx, [deleteStatement(env, ctx, path, now)], now);
}

/** Renames one text file. The target must not exist. */
export async function renameCodeSessionFile(
  env: SessionEnv,
  input: { sessionId: string; userId: string; from: string; to: string },
): Promise<SessionOutcome<CodeSessionEdit>> {
  const now = Date.now();
  const from = normalizeEditPath(input.from);
  const to = normalizeEditPath(input.to);
  if (!from || !to) return refuse("invalid_path", "The path is not a file in this repository.");
  if (from === to) return refuse("exists", `${to} already exists.`);
  const ctx = await editContext(env, input, now);
  if ("status" in ctx) return ctx;
  if (!exists(ctx, from)) return refuse("not_a_file", `${from} is not a file in this session.`);
  if (exists(ctx, to)) return refuse("exists", `${to} already exists.`);
  const shape = pathShapeConflict(
    to,
    livePaths(ctx).filter((p) => p !== from),
  );
  if (shape) return refuse("invalid_path", shape);
  const added = [from, to].filter((p) => !ctx.edits.has(p)).length;
  if (ctx.edits.size + added > MAX_SESSION_FILES) return tooMany();
  let content: string;
  const edit = ctx.edits.get(from);
  if (edit) {
    const stored = await env.DB.prepare(
      "SELECT content FROM code_session_files WHERE session_id = ? AND path = ?",
    )
      .bind(ctx.row.id, from)
      .first<{ content: string | null }>();
    content = stored?.content ?? "";
  } else {
    const entry = ctx.base.get(from);
    if (!entry) return refuse("not_a_file", `${from} is not a file in this session.`);
    const read = await readBaseText(env, ctx.row.project_id, entry);
    if ("status" in read) return read;
    content = read.text;
  }
  return commitEdits(
    env,
    ctx,
    [await writeStatement(env, ctx, to, content, now), deleteStatement(env, ctx, from, now)],
    now,
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Terminal                                                                                    */
/* ------------------------------------------------------------------------------------------ */

type Run = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };

/** One root command in the Sandbox with a hard deadline. A deadline miss is `timedOut`. */
async function run(
  sandbox: Sandbox,
  command: string,
  opts: { timeoutMs: number; env?: Record<string, string> },
): Promise<Run> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), opts.timeoutMs + 5_000);
  });
  try {
    const result = await Promise.race([
      // A subshell: a `cd` never changes the shared shell that agent and Candidate commands use.
      sandbox.exec(`(${command})`, {
        timeout: opts.timeoutMs,
        ...(opts.env ? { env: opts.env } : {}),
      }),
      deadline,
    ]);
    if (result === "timeout") return { exitCode: null, stdout: "", stderr: "", timedOut: true };
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: false,
    };
  } catch (error) {
    const message = String(error);
    if (/timed?\s*out|timeout/i.test(message)) {
      return { exitCode: null, stdout: "", stderr: "", timedOut: true };
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Runs `inner` (a shell word list) as the session user: a clean environment (PATH only, a session
 * HOME), no groups, no new privileges. Never given a token.
 */
const asSessionUser = (sessionId: string, inner: string) => {
  const uid = commandUid(sessionId);
  const home = shellQuote(`${sessionDir(sessionId)}.home`);
  return `env -i PATH="$PATH" HOME=${home} TERM=dumb LANG=C.UTF-8 setpriv --reuid=${uid} --regid=${uid} --clear-groups --no-new-privs ${inner}`;
};

/** Parses `git diff --name-status -z` output: status and path pairs. */
function parseNameStatus(output: string): { status: string; path: string }[] {
  const parts = output.split("\u0000");
  const out: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i] ?? "";
    const path = parts[i + 1] ?? "";
    if (status && path) out.push({ status: status.slice(0, 1), path });
  }
  return out;
}

const SANDBOX_BUSY =
  "The Sandbox is busy with work for another Project. Only one runs at a time. Try again in a few minutes.";

/**
 * True when the Sandbox refused to start because the account runs its maximum number of containers
 * (one, a cost rule). Agents and Candidate checks of another Project hold it.
 */
function containerUnavailable(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /ContainerUnavailableError|maximum number of running container instances/i.test(text);
}

/** Records why the readiness probe of a session checkout failed (Workers Logs). */
function probeFailed(row: SessionRow, error: string) {
  console.warn(
    JSON.stringify({
      event: "code_session.probe_failed",
      sessionId: row.id,
      projectId: row.project_id,
      error: error.slice(0, 300),
    }),
  );
}

/**
 * Prepares the session checkout: clone the fork at the base commit when it is missing, then reset
 * it to base plus the edits when the edits changed since the last sync. Returns notes for stderr.
 */
async function prepareCheckout(
  env: SessionEnv,
  sandbox: Sandbox,
  row: SessionRow,
): Promise<{ notes: string[] } | CodeSessionRefused> {
  const dir = sessionDir(row.id);
  const qdir = shellQuote(dir);
  const marker = `${dir}.rev`;
  let probe: Run;
  try {
    // The first command of a session can cold-start the container: give it the setup time.
    probe = await run(
      sandbox,
      `if [ "$(id -u)" != 0 ] || ! command -v setpriv >/dev/null 2>&1; then echo unsupported; elif [ -d ${qdir}/.git ]; then echo "ready $(cat ${shellQuote(marker)} 2>/dev/null)"; else echo missing; fi`,
      { timeoutMs: SETUP_TIMEOUT_MS },
    );
  } catch (error) {
    probeFailed(row, String(error));
    if (containerUnavailable(error)) return refuse("sandbox_busy", SANDBOX_BUSY);
    throw error;
  }
  const state = probe.stdout.trim();
  if (probe.timedOut) {
    probeFailed(row, `no answer in ${SETUP_TIMEOUT_MS / 1000} s`);
    return refuse("sandbox_busy", SANDBOX_BUSY);
  }
  if (probe.exitCode !== 0 || state === "unsupported") {
    probeFailed(row, `exit ${probe.exitCode}: ${(probe.stderr || state).slice(0, 200)}`);
    return refuse(
      "sandbox_unavailable",
      "The Sandbox cannot run commands as an unprivileged user, so the terminal is off.",
    );
  }
  const notes: string[] = [];
  const uid = commandUid(row.id);
  if (state === "missing") {
    if (!SHA.test(row.base_commit)) throw new Error("invalid base commit");
    using repo = await env.ARTIFACTS.get(codeSessionRepo(row.id));
    const info = await repo.info();
    const token = await repo.createToken("read", 600);
    const secret = token.plaintext.split("?expires=")[0] ?? token.plaintext;
    try {
      // Root clones with the token in its own environment; the session user never sees it.
      const clone = await run(
        sandbox,
        `rm -rf ${qdir} ${qdir}.home ${shellQuote(marker)} && mkdir -p ${qdir} ${qdir}.home && cd ${qdir} && git -c "http.extraHeader=$GIT_AUTH" clone -q ${shellQuote(info.remote)} . && git checkout -q -B main ${row.base_commit} && git config user.name Rhumbatron && git config user.email bot@rhumbatron.com && chown -R -h ${uid}:${uid} ${qdir} ${qdir}.home`,
        { timeoutMs: SETUP_TIMEOUT_MS, env: { GIT_AUTH: `Authorization: Bearer ${secret}` } },
      );
      if (clone.exitCode !== 0) {
        throw new Error(`session checkout failed: ${(clone.stderr || clone.stdout).slice(-300)}`);
      }
    } finally {
      await repo.revokeToken(token.id).catch(() => false);
    }
  }
  const synced = state.startsWith("ready ") ? state.slice(6).trim() : "";
  if (synced === String(row.revision)) return { notes };

  // Base plus the edits, exactly: reset tracked files, remove untracked ones (ignored files stay).
  const reset = await run(
    sandbox,
    `cd ${qdir} && ${asSessionUser(row.id, `sh -c ${shellQuote(`git reset -q --hard ${row.base_commit} && git clean -fdq`)}`)}`,
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (reset.exitCode !== 0) throw new Error(`session reset failed: ${reset.stderr.slice(-300)}`);
  const edits = await env.DB.prepare(
    "SELECT path, state, content FROM code_session_files WHERE session_id = ? ORDER BY path",
  )
    .bind(row.id)
    .all<{ path: string; state: string; content: string | null }>();
  const written = (edits.results ?? []).filter((e) => e.state === "written");
  const deleted = (edits.results ?? []).filter((e) => e.state === "deleted");
  if (written.length > 0 || deleted.length > 0) {
    // Root writes each file into a fresh root-owned staging folder; the session user copies it
    // into place. A symbolic link in the checkout then cannot lead a root write out of it.
    const stage = `/workspace/.stage-${row.id.slice(5)}`;
    await run(sandbox, `rm -rf ${shellQuote(stage)} && mkdir -m 755 ${shellQuote(stage)}`, {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    try {
      for (const [i, edit] of written.entries()) {
        await sandbox.writeFile(`${stage}/${i}`, edit.content ?? "");
      }
      const args = [
        ...deleted.flatMap((e) => ["-", e.path]),
        ...written.flatMap((e, i) => [`${stage}/${i}`, e.path]),
      ];
      const script =
        'while [ $# -gt 1 ]; do if [ "$1" = - ]; then rm -f -- "$2"; else mkdir -p -- "$(dirname -- "$2")" && cp -- "$1" "$2" || exit 1; fi; shift 2; done';
      const placed = await run(
        sandbox,
        `chmod 644 ${shellQuote(stage)}/* 2>/dev/null; cd ${qdir} && ${asSessionUser(row.id, `sh -c ${shellQuote(script)} sh ${args.map(shellQuote).join(" ")}`)}`,
        { timeoutMs: GIT_TIMEOUT_MS },
      );
      if (placed.exitCode !== 0) {
        throw new Error(`session sync failed: ${placed.stderr.slice(-300)}`);
      }
    } finally {
      await run(sandbox, `rm -rf ${shellQuote(stage)}`, { timeoutMs: GIT_TIMEOUT_MS }).catch(
        () => null,
      );
    }
  }
  await sandbox.writeFile(marker, String(row.revision));
  if (state === "missing") {
    // After the edits, so an edited package.json counts. Ignored folders (node_modules) stay
    // through later resets.
    const install = await run(
      sandbox,
      `cd ${qdir} && if [ -f package.json ]; then ${asSessionUser(row.id, "bun install")}; fi`,
      { timeoutMs: SETUP_TIMEOUT_MS },
    );
    if (install.exitCode !== 0) {
      notes.push(
        `rhumbatron: bun install did not complete (${install.timedOut ? "timed out" : `exit ${install.exitCode}`}).`,
      );
    }
  }
  return { notes };
}

/**
 * After a command: every file that differs from the base commit becomes a session edit, and an
 * edit whose file is back to base goes. Binary files, files over 256 KB, and invalid paths stay
 * out (a note says which). More than MAX_SESSION_FILES changed files import nothing.
 */
async function importChanges(
  env: SessionEnv,
  sandbox: Sandbox,
  row: SessionRow,
  now: number,
): Promise<{ notes: string[] }> {
  const dir = sessionDir(row.id);
  const qdir = shellQuote(dir);
  const listed = await run(
    sandbox,
    `cd ${qdir} && ${asSessionUser(row.id, `sh -c ${shellQuote(`git diff --no-renames --name-status -z ${row.base_commit} -- && printf '\\001' && git ls-files --others --exclude-standard -z`)}`)}`,
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (listed.exitCode !== 0) {
    return {
      notes: [
        "rhumbatron: the changed files could not be read; this command's edits are not in the session.",
      ],
    };
  }
  const [tracked = "", untracked = ""] = listed.stdout.split("\u0001");
  const changed = new Map<string, "deleted" | "written">();
  const skipped: string[] = [];
  for (const entry of parseNameStatus(tracked)) {
    changed.set(entry.path, entry.status === "D" ? "deleted" : "written");
  }
  for (const path of untracked.split("\u0000").filter(Boolean)) changed.set(path, "written");
  for (const path of [...changed.keys()]) {
    if (normalizeEditPath(path) !== path) {
      changed.delete(path);
      skipped.push(path);
    }
  }
  if (changed.size > MAX_SESSION_FILES) {
    return {
      notes: [
        `rhumbatron: ${changed.size} files differ from the base; a session holds at most ${MAX_SESSION_FILES}. The session edits did not change.`,
      ],
    };
  }

  const current = new Map((await fileRows(env, row.id)).map((f) => [f.path, f]));
  const written = [...changed].filter(([, state]) => state === "written").map(([path]) => path);
  // Only regular files whose real path is inside the checkout: a symbolic link (or a folder
  // link on the way) never leads the root read below out of it. No session process runs now.
  const hashes = new Map<string, { blob: string; size: number } | null>();
  if (written.length > 0) {
    const script =
      'd=$(pwd -P); for p in "$@"; do if [ -f "$p" ] && [ ! -L "$p" ] && [ "$(realpath -e -- "$p")" = "$d/$p" ]; then printf "%s %s\\n" "$(git hash-object -- "$p")" "$(stat -c %s -- "$p")"; else echo skip; fi; done';
    const hashed = await run(
      sandbox,
      `cd ${qdir} && ${asSessionUser(row.id, `sh -c ${shellQuote(script)} sh ${written.map(shellQuote).join(" ")}`)}`,
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    const lines = hashed.stdout.trim().split("\n");
    written.forEach((path, i) => {
      const [blob, size] = (
        hashed.exitCode === 0 && lines.length === written.length ? (lines[i] ?? "skip") : "skip"
      ).split(" ");
      hashes.set(
        path,
        blob && blob !== "skip" && SHA.test(blob) ? { blob, size: Number(size) } : null,
      );
    });
  }

  const statements: D1PreparedStatement[] = [];
  const kept = new Set<string>();
  const stamp = isoNow(now);
  for (const [path, state] of changed) {
    kept.add(path);
    const before = current.get(path);
    if (state === "deleted") {
      if (before?.state !== "deleted") {
        statements.push(
          env.DB.prepare(
            `INSERT INTO code_session_files (session_id, path, state, content, size, blob, updated_at)
             VALUES (?, ?, 'deleted', NULL, 0, NULL, ?)
             ON CONFLICT (session_id, path) DO UPDATE SET state = 'deleted', content = NULL,
               size = 0, blob = NULL, updated_at = excluded.updated_at`,
          ).bind(row.id, path, stamp),
        );
      }
      continue;
    }
    const hash = hashes.get(path);
    if (!hash || !Number.isFinite(hash.size) || hash.size > MAX_EDIT_BYTES) {
      skipped.push(path);
      continue;
    }
    if (before?.state === "written" && before.blob === hash.blob) continue;
    const file = await sandbox.readFile(`${dir}/${path}`).catch(() => null);
    if (!file || file.encoding === "base64" || file.isBinary || file.content.includes("\u0000")) {
      skipped.push(path);
      continue;
    }
    if (contentRefusal(file.content)) {
      skipped.push(path);
      continue;
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO code_session_files (session_id, path, state, content, size, blob, updated_at)
         VALUES (?, ?, 'written', ?, ?, ?, ?)
         ON CONFLICT (session_id, path) DO UPDATE SET state = 'written', content = excluded.content,
           size = excluded.size, blob = excluded.blob, updated_at = excluded.updated_at`,
      ).bind(
        row.id,
        path,
        file.content,
        new TextEncoder().encode(file.content).length,
        await gitBlobId(file.content),
        stamp,
      ),
    );
  }
  for (const [path] of current) {
    // Back to the base version: not an edit. A skipped file keeps its last edit.
    if (!kept.has(path) && !skipped.includes(path)) {
      statements.push(
        env.DB.prepare("DELETE FROM code_session_files WHERE session_id = ? AND path = ?").bind(
          row.id,
          path,
        ),
      );
    }
  }
  if (statements.length > 0) {
    const revision = row.revision + 1;
    // Several small batches: file content can be large, and the command lock blocks other edits.
    for (let i = 0; i < statements.length; i += 10) await env.DB.batch(statements.slice(i, i + 10));
    await env.DB.prepare("UPDATE code_sessions SET revision = ? WHERE id = ?")
      .bind(revision, row.id)
      .run();
    // The checkout already holds these edits: the next command needs no reset.
    await sandbox.writeFile(`${dir}.rev`, String(revision));
  }
  const notes: string[] = [];
  if (skipped.length > 0) {
    notes.push(
      `rhumbatron: not added to the session (binary, over ${MAX_EDIT_BYTES / 1024} KB, or an invalid path): ${skipped.slice(0, 10).join(", ")}${skipped.length > 10 ? ", ..." : ""}`,
    );
  }
  return { notes };
}

/**
 * Runs one terminal command in the session checkout (`cwd` relative to it), 120 s at most. The
 * Sandbox starts on the first command. Each command reserves Sandbox seconds and is refused at
 * the monthly cap. The command text (not its output) goes to the audit log.
 */
export async function execCodeSessionCommand(
  env: SessionEnv,
  input: { sessionId: string; userId: string; command: string; cwd?: string | undefined },
): Promise<SessionOutcome<CodeSessionExecResult>> {
  const now = Date.now();
  const cwd = normalizeCwd(input.cwd);
  if (cwd === null) return refuse("invalid_path", "The folder is not in this repository.");
  const command = input.command.trim();
  if (!command) return refuse("invalid_path", "The command is empty.");
  const loaded = await loadOpen(env, input.sessionId, input.userId, now);
  if (!("row" in loaded)) return loaded;
  const { row } = loaded;

  const lockedAt = isoNow(now);
  const lock = await env.DB.prepare(
    `UPDATE code_sessions SET exec_started_at = ?
     WHERE id = ? AND status = 'open' AND (exec_started_at IS NULL OR exec_started_at < ?)`,
  )
    .bind(lockedAt, row.id, isoNow(now - EXEC_LOCK_MS))
    .run();
  if ((lock.meta?.changes ?? 0) === 0) return BUSY();
  try {
    if (
      !(await reserveSessionSeconds(env.DB, EXEC_RESERVATION_SECONDS, env.SANDBOX_MONTHLY_SECONDS))
    ) {
      return refuse(
        "sandbox_cap",
        "The monthly Sandbox time is used up. Edit files and submit; the terminal is off until next month.",
      );
    }
    const startedAt = Date.now();
    let result: Run | null = null;
    let outcome: SessionOutcome<CodeSessionExecResult> | null = null;
    try {
      const sandbox = sandboxFor(env, row.project_id);
      const prepared = await prepareCheckout(env, sandbox, row);
      if ("status" in prepared) {
        outcome = prepared;
      } else {
        const where = shellQuote(cwd ? `${sessionDir(row.id)}/${cwd}` : sessionDir(row.id));
        const commandStart = Date.now();
        result = await run(
          sandbox,
          `cd ${where} && ${asSessionUser(row.id, `bash -c ${shellQuote(command)}`)}`,
          {
            timeoutMs: CODE_EXEC_TIMEOUT_MS,
          },
        );
        const durationMs = Date.now() - commandStart;
        // No process of the session outlives its command: no server, no watcher, no token reader.
        await run(sandbox, `${killSessionProcesses(row.id)} ; true`, {
          timeoutMs: GIT_TIMEOUT_MS,
        }).catch(() => null);
        const imported = await importChanges(env, sandbox, row, Date.now());
        const stdout = tailBytes(result.stdout);
        const notes = [...prepared.notes, ...imported.notes];
        if (result.timedOut)
          notes.push(
            `rhumbatron: the command reached the ${CODE_EXEC_TIMEOUT_MS / 1000} s limit and was stopped.`,
          );
        const stderr = tailBytes(
          [result.stderr.replace(/\n$/, ""), ...notes].filter(Boolean).join("\n"),
        );
        const edits = await fileRows(env, row.id);
        outcome = ok({
          exitCode: result.timedOut ? 124 : (result.exitCode ?? 1),
          stdout: stdout.text,
          stderr: stderr.text,
          durationMs,
          truncated: stdout.cut || stderr.cut,
          timedOut: result.timedOut,
          changedFiles: edits.map((e) => e.path),
          expiresAt: viewOf({ ...row, last_used_at: isoNow(Date.now()) }, [], Date.now()).expiresAt,
        });
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "code_session.exec_failed",
          sessionId: row.id,
          error: String(error).slice(0, 300),
        }),
      );
      outcome = containerUnavailable(error)
        ? refuse("sandbox_busy", SANDBOX_BUSY)
        : refuse(
            "sandbox_unavailable",
            "The Sandbox did not run the command. Try again in a minute.",
          );
    } finally {
      const endedAt = Date.now();
      // The session row keeps its own awake time; the meter charges the container's (shared).
      const billed = awakeSeconds({ startedAt, endedAt, awakeUntil: row.sandbox_awake_until });
      await settleSandboxUse(env.DB, {
        projectId: row.project_id,
        startedAt,
        endedAt,
        reservedSeconds: EXEC_RESERVATION_SECONDS,
      });
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE code_sessions SET sandbox_awake_until = ?, last_used_at = ? WHERE id = ?",
        ).bind(billed.awakeUntil, isoNow(endedAt), row.id),
        env.DB.prepare(
          "INSERT INTO code_session_commands (session_id, command, cwd, exit_code, duration_ms, at) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(
          row.id,
          command,
          cwd,
          result ? (result.timedOut ? 124 : result.exitCode) : null,
          endedAt - startedAt,
          isoNow(startedAt),
        ),
      ]);
    }
    return outcome;
  } finally {
    await env.DB.prepare(
      "UPDATE code_sessions SET exec_started_at = NULL WHERE id = ? AND exec_started_at = ?",
    )
      .bind(row.id, lockedAt)
      .run();
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Submit                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * The paths that block a submit on a newer canonical tree: each changed path whose blob differs
 * between the session base and canonical now. None means the edits apply to canonical now with
 * the same result, so the submit moves to the new base.
 */
function rebaseConflicts(
  changed: readonly string[],
  base: ReadonlyMap<string, Pick<CodeEntry, "blob">>,
  live: ReadonlyMap<string, Pick<CodeEntry, "blob">>,
): string[] {
  return changed.filter((path) => base.get(path)?.blob !== live.get(path)?.blob);
}

/** The Change goal of a session submit: `Edit <path>`, or `Edit N files: a, b, ...`. */
function sessionGoal(paths: readonly string[]): string {
  if (paths.length === 1) return `Edit ${paths[0]}`.slice(0, 200);
  return `Edit ${paths.length} files: ${paths.join(", ")}`.slice(0, 200);
}

/**
 * Commits every edit of the session as one Change with one human ChangeSet (the single-file save
 * path with several files), then ends the session. A repeat finds the same Change.
 */
export async function submitCodeSession(
  env: SessionEnv,
  input: { sessionId: string; userId: string; message: string; authorName: string | null },
): Promise<SessionOutcome<CodeSessionSubmitResult>> {
  const now = Date.now();
  if (!isCodeSessionId(input.sessionId)) return refuse("not_found", "Session not found.");
  const prior = await env.DB.prepare(`${SESSION_SQL} WHERE s.id = ?`)
    .bind(input.sessionId)
    .first<SessionRow>();
  if (prior && prior.user_id === input.userId && prior.status === "submitted" && prior.change_id) {
    const again = await existingHumanChange(env, prior.project_id, prior.change_id);
    if (again?.status === "existing") {
      const { changeId, changeSetId, candidateIds } = again;
      return ok({ changeId, changeSetId, candidateIds, status: "existing" });
    }
  }
  const loaded = await loadOpen(env, input.sessionId, input.userId, now);
  if (!("row" in loaded)) return loaded;
  const { row } = loaded;
  if (commandRunning(row, now)) return BUSY();

  const changeId = await changeIdFor(row.project_id, row.id, "code-session");
  const found = await existingHumanChange(env, row.project_id, changeId);
  if (found?.status === "existing") {
    await endSession(env, row, "submitted", null, { changeId, actorUserId: input.userId });
    const { changeSetId, candidateIds } = found;
    return ok({ changeId, changeSetId, candidateIds, status: "existing" });
  }

  const edits = await env.DB.prepare(
    "SELECT path, state, content FROM code_session_files WHERE session_id = ? ORDER BY path",
  )
    .bind(row.id)
    .all<{ path: string; state: string; content: string | null }>();
  const ops: HumanFileOp[] = (edits.results ?? []).map((e) => ({
    path: e.path,
    content: e.state === "written" ? (e.content ?? "") : null,
  }));
  if (ops.length === 0) return refuse("no_change", "Nothing changed in this session.");

  const root = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  const canonical = await root.get(root.idFromName(row.project_id)).getCanonical();
  if (!canonical || canonical.artifactRef === "unassigned") {
    return refuse("no_source", "The project has no source to edit.");
  }
  let base = { generation: row.base_generation, commit: row.base_commit };
  if (canonical.treeSha !== row.base_tree) {
    const [before, live] = await Promise.all([
      treeEntries(env, row.project_id, row.base_tree),
      treeEntries(env, row.project_id, canonical.treeSha),
    ]);
    const conflicts = rebaseConflicts(
      ops.map((op) => op.path),
      before,
      live,
    );
    if (conflicts.length > 0) {
      return refuse(
        "stale_base",
        `S${canonical.generation} also changed ${conflicts.slice(0, 5).join(", ")}${conflicts.length > 5 ? ", ..." : ""}. Copy your edits, discard the session, and open a new one.`,
      );
    }
    base = {
      generation: canonical.generation,
      commit: await baseCommitFor(env, row.project_id, canonical.treeSha),
    };
  }

  const message = input.message.trim();
  const outcome = await recordHumanChange(env, {
    projectId: row.project_id,
    userId: input.userId,
    authorName: input.authorName,
    message,
    changeId,
    ops,
    strict: false,
    base,
    goal: sessionGoal(ops.map((op) => op.path)),
    acceptance: [message],
    clientRequestId: `session-${row.id}`,
  });
  if (outcome.status === "refused") return refuse(outcome.reason, outcome.detail);
  await endSession(env, row, "submitted", null, {
    changeId: outcome.changeId,
    actorUserId: input.userId,
  });
  return ok({
    changeId: outcome.changeId,
    changeSetId: outcome.changeSetId,
    candidateIds: outcome.candidateIds,
    status: outcome.status,
  });
}
