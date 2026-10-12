import type { ProjectRootDO } from "@rhumbatron/coordinator";
import {
  boundPatch,
  type ChangeSetIntent,
  type CodeEditOutcome,
  changeSetPatchKey,
  checkEdit,
  humanEditsIntent,
  patchMetadata,
  sourceIndexKey,
  unifiedFilePatch,
} from "@rhumbatron/protocol";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createFsFromVolume, Volume } from "memfs";
import { composeChangeCandidates } from "./candidate-create.ts";
import { appendChangeEvents, type ChangeContext, changeEvent, qualify } from "./events.ts";
import { loadProjectPolicy } from "./policy.ts";

/**
 * Human edits (Phase 16 P16-19). A person saves one file on
 * the Code page. This records what an agent run records, with a person as the actor: a new Change
 * ("Edit <path>"), one completed Task and run, an Artifacts workspace fork of canonical with the
 * file committed, the stored patch, and a `proposed` ChangeSet. The Change then follows the agent
 * path from `verification.started`: compose, verify, promote by policy. A person never advances
 * canonical directly; only verified evidence does.
 *
 * The commit is made in this Worker with isomorphic-git over an in-memory file system, like the
 * canonical source sync: no Sandbox time. Names follow the agent convention (`run_<k>`, `cs_<k>`,
 * `ws-<k>`), so fork cleanup (repo-names.ts) and composition (`'run_' || substr(cs.id, 4)`) work
 * unchanged. Safe to repeat with the same `clientRequestId`: the IDs derive from it.
 *
 * A Code page edit session (ADR 0029, code-sessions.ts) submits through `recordHumanChange` with
 * several files: added, changed, and deleted. The record, the events, and composition are the same.
 */

const DIR = "/repo";
const TASK_KEY = "edit";
const BUDGET_USD = 3;

export type HumanEditInput = {
  projectId: string;
  userId: string;
  authorName: string | null;
  path: string;
  content: string;
  baseTree: string;
  message: string;
  clientRequestId?: string | undefined;
};

type Refused = Extract<CodeEditOutcome, { status: "refused" }>;
const refuse = (reason: Refused["reason"], detail: string): Refused => ({
  status: "refused",
  reason,
  detail,
});

/** Thrown inside the commit step for an edit that cannot apply; the fork is removed. */
class EditRefused extends Error {
  constructor(readonly refusal: Refused) {
    super(refusal.detail);
  }
}

type MemFs = Parameters<typeof git.init>[0]["fs"] & {
  promises: {
    writeFile(p: string, c: string): Promise<void>;
    mkdir(p: string, o?: { recursive?: boolean }): Promise<unknown>;
    unlink(p: string): Promise<void>;
  };
};

/** One file of a human Change: the whole new text, or `null` to delete the file. */
export type HumanFileOp = { path: string; content: string | null };

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The Change ID: derived from the client request (a single-file save) or the session ID (an edit
 * session), so a retried save or submit finds its own Change. The two kinds never share an ID.
 */
export async function changeIdFor(
  projectId: string,
  key: string | undefined,
  kind: "human-edit" | "code-session" = "human-edit",
) {
  if (!key) return `chg_${crypto.randomUUID()}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${kind}\n${projectId}\n${key}`),
  );
  return `chg_${hex(new Uint8Array(digest)).slice(0, 32)}`;
}

/** Commit on canonical `main` for `treeSha`: the source index, else the canonical repo log. */
export async function baseCommitFor(env: Env, projectId: string, treeSha: string) {
  const index = await env.EVIDENCE.get(sourceIndexKey(projectId, treeSha));
  const commit = index
    ? ((await index.json().catch(() => null)) as { commit?: string } | null)?.commit
    : undefined;
  if (commit) return commit;
  using repo = await env.ARTIFACTS.get(projectId);
  const [head] = await repo.log({ ref: "main", limit: 1 });
  if (head?.treeHash !== treeSha) throw new Error("canonical source index is not written yet");
  return head.hash;
}

/** Forks canonical into the edit's workspace fork. An existing fork (a retry) is reused. */
async function ensureFork(env: Env, projectId: string, fork: string, changeId: string) {
  using canonical = await env.ARTIFACTS.get(projectId);
  try {
    await canonical.fork(fork, { description: `Human edit ${changeId}`, defaultBranchOnly: true });
  } catch (error) {
    using existing = await env.ARTIFACTS.get(fork).catch(() => {
      throw error;
    });
    await existing.info();
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** One file that the human commit changed, with both versions for the Intent and the patch. */
type CommittedFile = {
  path: string;
  status: "added" | "deleted" | "modified";
  before: string;
  after: string;
  binary: boolean;
  oldBlob?: string;
  newBlob?: string;
};

/** Text of a base blob, or null for binary bytes (a NUL byte, or not UTF-8). */
function textOf(blob: Uint8Array): string | null {
  if (blob.includes(0)) return null;
  try {
    return decoder.decode(blob);
  } catch {
    return null;
  }
}

/**
 * Commits the file operations on `baseCommit` in the fork and pushes the fork's `main` (a
 * fast-forward from the canonical commit). The author is the person; the token is write-scoped,
 * short-lived, and revoked here.
 *
 * `strict` is the single-file save: the file must be a text file of the base tree and must change.
 * Otherwise (an edit session) a file can be added, changed, or deleted, and an operation that
 * changes nothing is dropped. No change at all is `no_change`.
 */
async function commitChanges(
  env: Env,
  input: {
    fork: string;
    baseCommit: string;
    ops: readonly HumanFileOp[];
    strict: boolean;
    message: string;
    author: { name: string; email: string };
    commitTime: number;
  },
): Promise<{ commit: string; files: CommittedFile[] }> {
  using repo = await env.ARTIFACTS.get(input.fork);
  const info = await repo.info();
  const token = await repo.createToken("write", 600);
  const secret = token.plaintext.split("?expires=")[0] ?? token.plaintext;
  const onAuth = () => ({ username: "x", password: secret });
  try {
    const fs = createFsFromVolume(new Volume()) as unknown as MemFs;
    await git.init({ fs, dir: DIR, defaultBranch: "main" });
    // isomorphic-git needs a configured remote for its fetch refspec.
    await git.addRemote({ fs, dir: DIR, remote: "origin", url: info.remote, force: true });
    await git.fetch({
      fs,
      http,
      dir: DIR,
      remote: "origin",
      url: info.remote,
      ref: "main",
      singleBranch: true,
      tags: false,
      onAuth,
    });
    const head = await git.resolveRef({ fs, dir: DIR, ref: "refs/remotes/origin/main" });
    if (head !== input.baseCommit) {
      throw new Error(`fork ${input.fork} main is at ${head.slice(0, 12)}, not the base commit`);
    }

    const files: CommittedFile[] = [];
    for (const op of input.ops) {
      let base: { oid: string; text: string | null } | null = null;
      try {
        const read = await git.readBlob({
          fs,
          dir: DIR,
          oid: input.baseCommit,
          filepath: op.path,
        });
        base = { oid: read.oid, text: textOf(read.blob) };
      } catch {
        base = null;
      }
      if (input.strict) {
        // A single-file save changes a text file of the base tree; it does not create one.
        if (!base) {
          throw new EditRefused(refuse("not_a_file", `${op.path} is not a file in this version.`));
        }
        if (base.text === null) throw new EditRefused(refuse("binary", "This file is binary."));
        if (base.text === op.content) {
          throw new EditRefused(refuse("no_change", "The file is unchanged."));
        }
      }
      if (op.content === null) {
        if (!base) continue;
        files.push({
          path: op.path,
          status: "deleted",
          before: base.text ?? "",
          after: "",
          binary: base.text === null,
          oldBlob: base.oid,
        });
      } else if (!base) {
        files.push({
          path: op.path,
          status: "added",
          before: "",
          after: op.content,
          binary: false,
        });
      } else if (base.text !== op.content) {
        files.push({
          path: op.path,
          status: "modified",
          before: base.text ?? "",
          after: op.content,
          binary: base.text === null,
          oldBlob: base.oid,
        });
      }
    }
    if (files.length === 0) throw new EditRefused(refuse("no_change", "Nothing changed."));

    await git.writeRef({ fs, dir: DIR, ref: "refs/heads/main", value: head, force: true });
    await git.checkout({ fs, dir: DIR, ref: "main", force: true });
    for (const file of files) {
      try {
        if (file.status === "deleted") {
          await fs.promises.unlink(`${DIR}/${file.path}`);
          await git.remove({ fs, dir: DIR, filepath: file.path });
          continue;
        }
        const parent = file.path.includes("/")
          ? file.path.slice(0, file.path.lastIndexOf("/"))
          : "";
        if (parent) await fs.promises.mkdir(`${DIR}/${parent}`, { recursive: true });
        await fs.promises.writeFile(`${DIR}/${file.path}`, file.after);
        await git.add({ fs, dir: DIR, filepath: file.path });
      } catch {
        // For example a new file under a path that is a file in the base tree.
        throw new EditRefused(refuse("invalid_path", `${file.path} cannot be written here.`));
      }
    }
    const signature = { ...input.author, timestamp: input.commitTime, timezoneOffset: 0 };
    const commit = await git.commit({
      fs,
      dir: DIR,
      message: input.message,
      author: signature,
      committer: {
        name: "Rhumbatron",
        email: "bot@rhumbatron.com",
        timestamp: input.commitTime,
        timezoneOffset: 0,
      },
    });
    const pushed = await git.push({ fs, http, dir: DIR, url: info.remote, ref: "main", onAuth });
    if (!pushed.ok) throw new Error(`push rejected: ${JSON.stringify(pushed.refs).slice(0, 200)}`);
    for (const file of files) {
      if (file.status === "deleted") continue;
      const { oid } = await git.readBlob({ fs, dir: DIR, oid: commit, filepath: file.path });
      file.newBlob = oid;
    }
    return { commit, files };
  } finally {
    await repo.revokeToken(token.id).catch(() => false);
  }
}

/** `git diff --stat` text of the committed files. */
function humanDiffStat(changes: readonly { path: string; additions: number; deletions: number }[]) {
  let additions = 0;
  let deletions = 0;
  const lines = changes.map((c) => {
    additions += c.additions;
    deletions += c.deletions;
    return ` ${c.path} | ${c.additions + c.deletions} ${"+".repeat(Math.min(c.additions, 40))}${"-".repeat(Math.min(c.deletions, 40))}`;
  });
  const count = changes.length === 1 ? "1 file" : `${changes.length} files`;
  lines.push(` ${count} changed, ${additions} insertions(+), ${deletions} deletions(-)`);
  return lines.join("\n");
}

async function existingOutcome(env: Env, changeId: string, changeSetId: string) {
  // Composition is idempotent (Candidate IDs are composition keys): a retry after a failed
  // compose finishes it.
  await composeChangeCandidates(env, changeId).catch(() => null);
  const rows = await env.DB.prepare("SELECT id FROM candidates WHERE change_id = ? ORDER BY id")
    .bind(changeId)
    .all<{ id: string }>();
  return {
    status: "existing" as const,
    changeId,
    changeSetId,
    candidateIds: (rows.results ?? []).map((r) => r.id),
  };
}

/** The row IDs and the fork name of a human Change, all derived from its Change ID. */
const humanIds = (changeId: string) => {
  const k = changeId.slice(4);
  return {
    taskId: `tsk_${k}_${TASK_KEY}`,
    runId: `run_${k}`,
    changeSetId: `cs_${k}`,
    fork: `ws-${k}`,
  };
};

/**
 * The outcome of a human Change that already exists in this Project (a repeated save or submit),
 * or null. A repeat never commits or records twice.
 */
export async function existingHumanChange(
  env: Env,
  projectId: string,
  changeId: string,
): Promise<CodeEditOutcome | null> {
  const ids = humanIds(changeId);
  const existing = await env.DB.prepare(
    `SELECT cs.id FROM changesets cs JOIN changes c ON c.id = cs.change_id
     WHERE cs.id = ? AND c.project_id = ?`,
  )
    .bind(ids.changeSetId, projectId)
    .first<{ id: string }>();
  return existing ? existingOutcome(env, changeId, ids.changeSetId) : null;
}

/**
 * Records one human edit as a new Change with one proposed ChangeSet and starts composition. The
 * API authenticated the person and checked Project membership; the size, text, path, and base
 * tree checks run again here against the authoritative canonical state.
 */
export async function submitHumanEdit(env: Env, input: HumanEditInput): Promise<CodeEditOutcome> {
  const project = await env.DB.prepare("SELECT status FROM projects WHERE id = ?")
    .bind(input.projectId)
    .first<{ status: string }>();
  if (!project) return refuse("not_found", "Project not found");
  if (project.status === "archived") return refuse("archived", "Project is archived");

  const changeId = await changeIdFor(input.projectId, input.clientRequestId);
  const existing = await existingHumanChange(env, input.projectId, changeId);
  if (existing) return existing;

  const root = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  const canonical = await root.get(root.idFromName(input.projectId)).getCanonical();
  const liveTree = canonical && canonical.artifactRef !== "unassigned" ? canonical.treeSha : null;
  const checked = checkEdit(input, liveTree);
  if (checked.status === "refused") return checked;
  if (!canonical) return refuse("no_source", "The project has no source to edit.");
  const path = checked.path;

  return recordHumanChange(env, {
    projectId: input.projectId,
    userId: input.userId,
    authorName: input.authorName,
    message: input.message,
    changeId,
    ops: [{ path, content: input.content }],
    strict: true,
    base: {
      generation: canonical.generation,
      commit: await baseCommitFor(env, input.projectId, canonical.treeSha),
    },
    goal: `Edit ${path}`,
    acceptance: [input.message.trim(), `${path} holds the saved content.`],
    clientRequestId: input.clientRequestId ? `edit-${input.clientRequestId}` : null,
  });
}

export type HumanChangeInput = {
  projectId: string;
  userId: string;
  authorName: string | null;
  message: string;
  /** From `changeIdFor`: every row ID and the fork name derive from it. */
  changeId: string;
  ops: readonly HumanFileOp[];
  strict: boolean;
  /** The canonical generation and commit on `main` that the operations apply to. */
  base: { generation: number; commit: string };
  goal: string;
  acceptance: string[];
  /** Stored in `changes.client_request_id`. */
  clientRequestId: string | null;
};

/**
 * Records a human Change: a new Change, one completed Task and run, the workspace fork of
 * canonical with one commit of every file operation, the stored patch, and a `proposed`
 * ChangeSet. Then composition starts. The caller validated paths, sizes, and the base.
 */
export async function recordHumanChange(
  env: Env,
  input: HumanChangeInput,
): Promise<CodeEditOutcome> {
  const project = await env.DB.prepare("SELECT org_id, slug, status FROM projects WHERE id = ?")
    .bind(input.projectId)
    .first<{ org_id: string; slug: string; status: string }>();
  if (!project) return refuse("not_found", "Project not found");
  if (project.status === "archived") return refuse("archived", "Project is archived");
  const { changeId } = input;
  const ids = humanIds(changeId);
  const baseCommit = input.base.commit;
  const policy = await loadProjectPolicy(env, input.projectId);
  const now = new Date();
  const createdAt = now.toISOString();
  const name = input.authorName?.trim() || null;
  const message = input.message.trim();

  let committed: Awaited<ReturnType<typeof commitChanges>>;
  try {
    await ensureFork(env, input.projectId, ids.fork, changeId);
    committed = await commitChanges(env, {
      fork: ids.fork,
      baseCommit,
      ops: input.ops,
      strict: input.strict,
      message: `${message}\n\nEdited by ${name ?? input.userId} on the Rhumbatron Code page.`,
      author: {
        name: name ?? input.userId,
        email: `${input.userId.toLowerCase().replace(/[^a-z0-9._-]/g, "-")}@users.rhumbatron.com`,
      },
      commitTime: Math.floor(now.getTime() / 1000),
    });
  } catch (error) {
    // No D1 row tracks the fork yet, so cleanup could never find it: remove it now.
    await env.ARTIFACTS.delete(ids.fork).catch(() => false);
    if (error instanceof EditRefused) return error.refusal;
    throw error;
  }

  const paths = committed.files.map((f) => f.path);
  const intent = humanEditsIntent({
    files: committed.files.map((f) => ({
      path: f.path,
      before: f.binary ? "" : f.before,
      after: f.binary ? "" : f.after,
    })),
    message,
    protectedResources: policy.protectedResources,
  });
  const diffs = committed.files.map((f) => ({
    path: f.path,
    ...unifiedFilePatch({
      path: f.path,
      before: f.before,
      after: f.after,
      status: f.status,
      binary: f.binary,
      ...(f.oldBlob ? { oldBlob: f.oldBlob } : {}),
      ...(f.newBlob ? { newBlob: f.newBlob } : {}),
    }),
  }));
  // The Files changed read model. A failure leaves the ChangeSet without `patchRef`, as for agents.
  let patchRef: string | undefined;
  try {
    const bounded = boundPatch(diffs.map((d) => d.patch).join(""));
    const key = changeSetPatchKey(input.projectId, ids.changeSetId);
    await env.EVIDENCE.put(key, bounded.patch, {
      httpMetadata: { contentType: "text/x-diff; charset=utf-8" },
      customMetadata: patchMetadata({ base: baseCommit, head: committed.commit, ...bounded }),
    });
    patchRef = key;
  } catch {
    console.warn(JSON.stringify({ event: "human_edit.patch_write_failed", changeId }));
  }

  const declared: ChangeSetIntent = {
    summary: intent.summary,
    semanticResources: intent.semanticResources,
    expectedFiles: intent.expectedFiles,
    expectedContractChanges: intent.expectedContractChanges,
    expectedDataChanges: intent.expectedDataChanges,
    assumptions: intent.assumptions,
    acceptanceEvidence: [],
    actor: { kind: "user", id: input.userId, name },
    changeSet: {
      fork: ids.fork,
      commit: committed.commit,
      baseCommit,
      diffStat: humanDiffStat(diffs),
      files: paths,
      stackedOn: [],
      ...(patchRef ? { patchRef } : {}),
    },
  };
  const outcome = JSON.stringify(declared);
  const goal = input.goal;
  const ctx: ChangeContext = {
    projectId: input.projectId,
    orgId: project.org_id,
    projectSlug: project.slug,
    changeId,
    baseGeneration: input.base.generation,
  };
  const acceptance = input.acceptance;
  // One D1 batch is one transaction: the Change never exists without its ChangeSet. On failure
  // no row tracks the fork, so it is removed; a retry forks and commits again.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO changes (id, project_id, goal, status, base_generation, risk_tier,
         budget_usd, client_request_id, created_by, acceptance_criteria_json, invariants_json,
         created_at, updated_at)
       VALUES (?, ?, ?, 'verifying', ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
    ).bind(
      changeId,
      input.projectId,
      goal,
      input.base.generation,
      intent.riskTier,
      BUDGET_USD,
      input.clientRequestId,
      input.userId,
      JSON.stringify(acceptance),
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO tasks (id, change_id, kind, semantic_resource, status, assigned_agent_id,
         complexity, risk_tier, model_policy, task_key, title, objective, acceptance_criteria_json,
         semantic_resources_json, route_json, wake_sent_at, created_at, updated_at)
       VALUES (?, ?, 'implement', ?, 'completed', ?, 'small', ?, 'human', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      ids.taskId,
      changeId,
      qualify(ctx, intent.semanticResources[0] ?? "general"),
      input.userId,
      intent.riskTier,
      TASK_KEY,
      goal,
      message,
      JSON.stringify(acceptance),
      JSON.stringify(intent.semanticResources.map((r) => qualify(ctx, r))),
      JSON.stringify({
        touchesAuthorization: intent.touchesAuthorization,
        touchesBilling: false,
        touchesMigration: intent.touchesMigration,
        source: "human",
      }),
      createdAt,
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO task_runs (id, task_id, agent_id, attempt, tier, status, outcome_json,
         model_calls, input_tokens, output_tokens, cost_usd, started_at, ended_at)
       VALUES (?, ?, ?, 1, 'human', 'completed', ?, 0, 0, 0, 0, ?, ?)`,
    ).bind(ids.runId, ids.taskId, input.userId, outcome, createdAt, createdAt),
    env.DB.prepare(
      `INSERT OR IGNORE INTO changesets (id, change_id, agent_id, base_generation, artifact_ref,
         intent_json, resources_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
    ).bind(
      ids.changeSetId,
      changeId,
      input.userId,
      input.base.generation,
      `artifacts://${ids.fork}@${committed.commit}`,
      outcome,
      JSON.stringify(intent.semanticResources),
      createdAt,
    ),
  ]).catch(async (error: unknown) => {
    await env.ARTIFACTS.delete(ids.fork).catch(() => false);
    throw error;
  });

  const actor = { kind: "user" as const, id: input.userId };
  const resource = qualify(ctx, intent.semanticResources[0] ?? "general");
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(ctx, "change.compiled", {
      taskCount: 1,
      riskTier: intent.riskTier,
      workGraphRef: null,
      planner: [],
      source: "human",
    }),
    await changeEvent(
      ctx,
      "task.created",
      { key: TASK_KEY, title: goal, kind: "implement", dependsOn: [], source: "human" },
      { taskId: ids.taskId, resource, actor },
    ),
    await changeEvent(
      ctx,
      "changeset.proposed",
      {
        changeSetId: ids.changeSetId,
        fork: ids.fork,
        commit: committed.commit,
        files: paths,
        stackedOn: [],
        source: "human",
      },
      { taskId: ids.taskId, resource, actor },
    ),
    await changeEvent(
      ctx,
      "task.completed",
      { runId: ids.runId, tier: "human", attempt: 1, source: "human" },
      { taskId: ids.taskId, resource, actor },
    ),
    // The agent path from here: the event router queues `candidate.create`.
    await changeEvent(ctx, "verification.started", {
      reason: "work_graph_completed",
      source: "human",
    }),
  ]);

  // Composing now saves a Queue round trip; the queued command then finds the same Candidates.
  let candidateIds: string[] = [];
  try {
    const composed = await composeChangeCandidates(env, changeId);
    if (composed.status === "composed") {
      candidateIds = composed.candidates.flatMap((c) =>
        "candidateId" in c ? [c.candidateId] : [],
      );
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "human_edit.compose_deferred",
        changeId,
        message: String(error).slice(0, 200),
      }),
    );
  }
  return { status: "created", changeId, changeSetId: ids.changeSetId, candidateIds };
}
