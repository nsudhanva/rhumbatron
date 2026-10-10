import type {
  CandidateDetail,
  Intent,
  TaskDetail,
  TaskRun,
  WorkspaceChangeSet,
  WorkspaceView,
} from "../../lib/api";
import { formatNumber, plural } from "../../lib/format";
import { readableArea } from "./headline";

/**
 * Read helpers for the Change page: file counts from the recorded code changes (workspace
 * `fileStats`, never estimated), planned files from approaches, and areas in plain words.
 */

export type FileStat = { path: string; adds: number | null; dels: number | null };

export type FilesSummary = {
  files: FileStat[];
  adds: number;
  dels: number;
  /** Every code change was found (a version can compose code changes the API did not list). */
  complete: boolean;
};

function summarize(sets: WorkspaceChangeSet[], complete: boolean): FilesSummary {
  const byPath = new Map<string, FileStat>();
  for (const set of sets) {
    const stats =
      set.fileStats.length > 0
        ? set.fileStats
        : set.files.map((path) => ({ path, adds: null, dels: null }));
    for (const stat of stats) {
      const prior = byPath.get(stat.path);
      const add = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);
      byPath.set(
        stat.path,
        prior
          ? { path: stat.path, adds: add(prior.adds, stat.adds), dels: add(prior.dels, stat.dels) }
          : { path: stat.path, adds: stat.adds, dels: stat.dels },
      );
    }
  }
  return {
    files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    adds: sets.reduce((sum, s) => sum + s.insertions, 0),
    dels: sets.reduce((sum, s) => sum + s.deletions, 0),
    complete,
  };
}

/** The newest recorded code change of one task (highest attempt). */
function taskChangeSet(view: WorkspaceView | undefined, taskId: string) {
  const forks = (view?.workspaces ?? [])
    .filter((w) => w.taskId === taskId && w.changeSet)
    .sort((a, b) => (b.attempt ?? 0) - (a.attempt ?? 0));
  return forks[0]?.changeSet ?? null;
}

export function taskFiles(view: WorkspaceView | undefined, taskId: string): FilesSummary | null {
  const set = taskChangeSet(view, taskId);
  return set ? summarize([set], true) : null;
}

/** Files of one version: the code changes it composes. Null when none were found. */
export function versionFiles(
  view: WorkspaceView | undefined,
  candidate: CandidateDetail,
): FilesSummary | null {
  const wanted = new Set(candidate.changeSetIds);
  const sets = (view?.workspaces ?? []).flatMap((w) =>
    w.changeSet && wanted.has(w.changeSet.id) ? [w.changeSet] : [],
  );
  if (sets.length === 0) return null;
  return summarize(sets, sets.length === wanted.size);
}

/** Files of every task's newest code change, before any version exists. */
function changeFiles(view: WorkspaceView | undefined, tasks: TaskDetail[]) {
  const sets = tasks.flatMap((t) => {
    const set = taskChangeSet(view, t.id);
    return set ? [set] : [];
  });
  return sets.length === 0 ? null : summarize(sets, sets.length === tasks.length);
}

/** `4 files changed +120 −8`. */
export function filesLine(files: FilesSummary) {
  return `${plural(files.files.length, "file")} changed ${statLine(files)}`;
}

/** `+120 −8` for one file, or nothing for a binary file. */
export function statLine(stat: Pick<FileStat, "adds" | "dels">) {
  if (stat.adds === null || stat.dels === null) return "";
  return `+${formatNumber(stat.adds)} −${formatNumber(stat.dels)}`;
}

const isIntent = (outcome: TaskRun["outcome"]): outcome is Intent =>
  outcome !== null && "summary" in outcome;

/** The newest approach (Intent) a task's agent declared, from any run. */
export function taskApproach(task: TaskDetail): Intent | null {
  for (let i = task.runs.length - 1; i >= 0; i--) {
    const outcome = task.runs[i]?.outcome ?? null;
    if (isIntent(outcome)) return outcome;
  }
  return null;
}

/** Planned files from approaches, for tasks without a recorded code change. */
function plannedFiles(tasks: TaskDetail[]) {
  const paths = new Set<string>();
  for (const task of tasks)
    for (const path of taskApproach(task)?.expectedFiles ?? []) paths.add(path);
  return [...paths].sort();
}

/** Unique areas of the Change in plain words, from every task's resources. */
export function areasOf(tasks: TaskDetail[]) {
  const areas = new Set<string>();
  for (const task of tasks) for (const r of task.semanticResources) areas.add(readableArea(r));
  return [...areas].filter(Boolean).sort();
}

const MODEL_NAME: Record<TaskRun["tier"], string> = {
  haiku: "Claude Haiku",
  sonnet: "Claude Sonnet",
  opus: "Claude Opus",
};

export const modelName = (tier: TaskRun["tier"]) => MODEL_NAME[tier];

/**
 * The Change's files for the tab and the side card: the focus version's code changes, else every
 * task's newest code change, else the files the approaches planned to touch (no counts).
 */
export function changeFileView(
  view: WorkspaceView | undefined,
  tasks: TaskDetail[],
  focus: CandidateDetail | null,
) {
  const fromVersion = focus ? versionFiles(view, focus) : null;
  const summary = fromVersion ?? changeFiles(view, tasks);
  const planned = summary ? [] : plannedFiles(tasks);
  return {
    summary,
    source: fromVersion
      ? ("version" as const)
      : summary
        ? ("tasks" as const)
        : ("planned" as const),
    planned,
    count: summary ? summary.files.length : planned.length,
  };
}

export type ChangeFileView = ReturnType<typeof changeFileView>;
