import type {
  CandidateDetail,
  CandidateFork,
  WorkspaceChangeSet,
  WorkspaceFork,
  WorkspaceView,
} from "../../lib/api";
import { candidateLabels } from "../candidate/model";

/** Short commit or tree hash for dense rows (DESIGN.md 9.11). */
export const shortSha = (value: string | null | undefined, length = 8) =>
  value ? value.slice(0, length) : null;

/** `artifacts://proj_x@main` -> `{ repo: "proj_x", ref: "main" }`. */
export function parseArtifactRef(ref: string) {
  const body = ref.replace(/^artifacts:\/\//, "");
  const at = body.lastIndexOf("@");
  return at < 0 ? { repo: body, ref: null } : { repo: body.slice(0, at), ref: body.slice(at + 1) };
}

export type ForkRow =
  | {
      kind: "workspace";
      key: string;
      name: string;
      fork: WorkspaceFork;
      commit: string | null;
      adds: number | null;
      dels: number | null;
      /** Status for the pill: the ChangeSet status once published, else the run status. */
      status: string;
      statusLabel?: string;
      state: string;
    }
  | {
      kind: "candidate";
      key: string;
      name: string;
      fork: CandidateFork;
      label: string;
      commit: string | null;
      adds: number | null;
      dels: number | null;
      /** True when every composed ChangeSet was found, so the sum covers the whole Candidate. */
      complete: boolean;
      /** Workspace fork rows whose ChangeSets this Candidate composes. */
      composes: string[];
      status: string;
      state: string;
    };

const workspaceKey = (fork: WorkspaceFork) => `ws:${fork.fork}`;
const candidateKey = (fork: CandidateFork) => `cand:${fork.id}`;

/**
 * Fork rows of one Change (or all loaded Changes), Task forks first, then Candidate forks.
 * Both fork from the canonical Artifact, so they are siblings under the canonical root; a
 * Candidate names the Task forks whose ChangeSets it composes.
 */
export function forkRows(view: WorkspaceView, changeId: string | null): ForkRow[] {
  const inScope = (id: string) => changeId === null || id === changeId;
  const changeOrder = new Map(view.changes.map((c, index) => [c.id, index]));
  const byChange = (a: { changeId: string }, b: { changeId: string }) =>
    (changeOrder.get(a.changeId) ?? 0) - (changeOrder.get(b.changeId) ?? 0);

  const workspaces = view.workspaces.filter((w) => inScope(w.changeId)).sort(byChange);
  const setOwner = new Map<string, WorkspaceFork>();
  for (const w of view.workspaces) if (w.changeSet) setOwner.set(w.changeSet.id, w);

  const rows: ForkRow[] = workspaces.map((fork) => {
    const set = fork.changeSet;
    const status = set
      ? set.status
      : fork.runStatus === "completed"
        ? "skipped"
        : (fork.runStatus ?? "pending");
    return {
      kind: "workspace",
      key: workspaceKey(fork),
      name: fork.fork,
      fork,
      commit: set?.commit ?? null,
      adds: set ? set.insertions : null,
      dels: set ? set.deletions : null,
      status,
      ...(!set && fork.runStatus === "completed" ? { statusLabel: "No changes" } : {}),
      state: [fork.taskKey, fork.attempt ? `attempt ${fork.attempt}` : null]
        .filter(Boolean)
        .join(" · "),
    };
  });

  const labels = labelsByChange(view.candidates);
  for (const fork of view.candidates.filter((c) => inScope(c.changeId)).sort(byChange)) {
    const owners = fork.changeSetIds.map((id) => setOwner.get(id));
    const found = owners.filter((o): o is WorkspaceFork => !!o?.changeSet);
    const complete = found.length === fork.changeSetIds.length;
    const sum = (pick: (s: WorkspaceChangeSet) => number) =>
      found.reduce((total, o) => total + (o.changeSet ? pick(o.changeSet) : 0), 0);
    const label = labels.get(fork.id) ?? "Candidate";
    rows.push({
      kind: "candidate",
      key: candidateKey(fork),
      name: fork.fork,
      fork,
      label,
      commit: fork.composedCommit,
      adds: found.length ? sum((s) => s.insertions) : null,
      dels: found.length ? sum((s) => s.deletions) : null,
      complete,
      composes: found.map(workspaceKey),
      status: fork.status,
      state: `${label} · composes ${fork.changeSetIds.length}`,
    });
  }
  return rows;
}

/** One Candidate name across pages: the same letters as `candidateLabels`, per Change. */
function labelsByChange(candidates: CandidateFork[]) {
  const groups = new Map<string, CandidateFork[]>();
  for (const c of candidates) groups.set(c.changeId, [...(groups.get(c.changeId) ?? []), c]);
  const labels = new Map<string, string>();
  for (const group of groups.values()) {
    // `candidateLabels` reads only id, createdAt and changeSetIds, which a fork row carries.
    for (const [id, label] of candidateLabels(group as unknown as CandidateDetail[])) {
      labels.set(id, label);
    }
  }
  return labels;
}

/** Changes that own at least one fork, with their fork counts, newest first. */
export function changesWithForks(view: WorkspaceView) {
  const counts = new Map<string, number>();
  for (const f of [...view.workspaces, ...view.candidates]) {
    counts.set(f.changeId, (counts.get(f.changeId) ?? 0) + 1);
  }
  return view.changes
    .filter((c) => counts.has(c.id))
    .map((c) => ({ ...c, forks: counts.get(c.id) ?? 0 }));
}

const ACTIVE_RUN = new Set(["running"]);
const ACTIVE_CANDIDATE = new Set(["composing", "composed", "verifying"]);

export function isWorkspaceActive(view: WorkspaceView | undefined) {
  if (!view) return false;
  return (
    view.workspaces.some((w) => ACTIVE_RUN.has(w.runStatus ?? "")) ||
    view.candidates.some((c) => ACTIVE_CANDIDATE.has(c.status))
  );
}

/* ---- Canonical file index ---------------------------------------------------------------- */

export type FileNode = {
  name: string;
  path: string;
  children: Map<string, FileNode> | null;
  files: number;
};

/** Builds a directory tree from sorted file paths. Directories carry their file count. */
export function buildFileTree(paths: string[]): FileNode {
  const root: FileNode = { name: "", path: "", children: new Map(), files: 0 };
  for (const path of paths) {
    const parts = path.split("/");
    let node = root;
    node.files += 1;
    for (const [index, part] of parts.entries()) {
      const isFile = index === parts.length - 1;
      const children = node.children ?? new Map<string, FileNode>();
      node.children = children;
      let next = children.get(part);
      if (!next) {
        next = {
          name: part,
          path: parts.slice(0, index + 1).join("/"),
          children: isFile ? null : new Map(),
          files: 0,
        };
        children.set(part, next);
      }
      if (!isFile) next.files += 1;
      node = next;
    }
  }
  return root;
}

export type FileRow = {
  path: string;
  name: string;
  /** Box-drawing prefix (`│  ├─ `), set in `white-space: pre`. */
  prefix: string;
  isDir: boolean;
  files: number;
  expanded: boolean;
};

/** Directories first, then files, each alphabetical. */
function sortedChildren(node: FileNode) {
  return [...(node.children?.values() ?? [])].sort((a, b) => {
    if (!!a.children !== !!b.children) return a.children ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Visible rows of the tree with only `expanded` directories opened. */
export function flattenFileTree(root: FileNode, expanded: Set<string>): FileRow[] {
  const rows: FileRow[] = [];
  const walk = (node: FileNode, lead: string) => {
    const children = sortedChildren(node);
    for (const [index, child] of children.entries()) {
      const last = index === children.length - 1;
      const open = !!child.children && expanded.has(child.path);
      rows.push({
        path: child.path,
        name: child.name,
        prefix: `${lead}${last ? "└─ " : "├─ "}`,
        isDir: !!child.children,
        files: child.files,
        expanded: open,
      });
      if (open) walk(child, `${lead}${last ? "   " : "│  "}`);
    }
  };
  walk(root, "");
  return rows;
}

/** Directories opened on first view: all of them for a small tree, else the top level only. */
export function defaultExpanded(root: FileNode, smallTree = 80): Set<string> {
  const open = new Set<string>();
  const walk = (node: FileNode, depth: number) => {
    for (const child of node.children?.values() ?? []) {
      if (!child.children) continue;
      if (root.files <= smallTree || depth === 0) open.add(child.path);
      if (root.files <= smallTree) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return open;
}
