/**
 * Artifacts repo names in the `rhumbatron-projects-<env>` namespace.
 * - Canonical repo: the Project ID (`proj_<uuid>`).
 * - Task Workspace fork: `ws-<run>` for Task run `run_<run>` (workers/agents/src/workspace.ts).
 * - Candidate fork: `cand-<candidate>` for Candidate `cand_<candidate>`.
 * - Code page edit session fork: `edit-<hex>` for session `edit_<hex>` (code-sessions.ts).
 * Names are derived from D1 row IDs only. Cleanup never lists the namespace and deletes by prefix,
 * so one Project's cleanup cannot reach another Project's repos.
 */

import { codeSessionRepo, isCodeSessionId } from "@rhumbatron/protocol";

const PROJECT_ID = /^proj_[a-z0-9-]+$/;
const RUN_ID = /^run_[A-Za-z0-9_-]+$/;
const CANDIDATE_ID = /^cand_[a-z0-9]+$/;

export const isProjectId = (id: string) => PROJECT_ID.test(id);

export const candidateFork = (candidateId: string) => `cand-${candidateId.slice(5)}`;

/** Must match `openWorkspace` in workers/agents/src/workspace.ts. */
const workspaceFork = (runId: string) => `ws-${runId.slice(4)}`;

export type ForkKind = "workspace" | "candidate" | "edit";

/** One fork candidate for deletion, as read from D1 with the Project that owns its Change. */
export type ForkRow = { kind: ForkKind; id: string; project_id: string };

export type OwnedFork = { kind: ForkKind; id: string; name: string };

/**
 * The forks of `projectId` among `rows`, with their repo names. A row of another Project, or with
 * an ID that does not have the expected shape, is dropped: it can never become a delete.
 */
export function forksOwnedBy(projectId: string, rows: ForkRow[]): OwnedFork[] {
  if (!isProjectId(projectId)) return [];
  const owned: OwnedFork[] = [];
  for (const row of rows) {
    if (row.project_id !== projectId) continue;
    if (row.kind === "workspace" && RUN_ID.test(row.id)) {
      owned.push({ kind: "workspace", id: row.id, name: workspaceFork(row.id) });
    } else if (row.kind === "candidate" && CANDIDATE_ID.test(row.id)) {
      owned.push({ kind: "candidate", id: row.id, name: candidateFork(row.id) });
    } else if (row.kind === "edit" && isCodeSessionId(row.id)) {
      owned.push({ kind: "edit", id: row.id, name: codeSessionRepo(row.id) });
    }
  }
  return owned;
}
