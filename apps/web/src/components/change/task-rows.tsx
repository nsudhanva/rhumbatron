import { useEffect, useState } from "react";
import type { RunProgress, TaskDetail, TaskRun, WorkspaceView } from "../../lib/api";
import { elapsed, formatNumber, formatUsd, plural, runDuration } from "../../lib/format";
import { describeStep } from "../agents/activity-model";
import { TechnicalDetails } from "../candidate/technical-details";
import { StatusIcon, statusView } from "../ui/status-pill";
import { failureReason, readableArea } from "./headline";
import { filesLine, modelName, statLine, taskApproach, taskFiles } from "./model";

/**
 * One row per task (docs/ux/research-2026-10-09.md 7.4, step 2): what the agent is doing now as a
 * sentence, its approach, and the files it changed. Models, tokens and routing sit behind
 * "Technical details".
 */

const ORDER: Record<TaskDetail["status"], number> = {
  failed: 0,
  running: 1,
  assigned: 1,
  blocked: 2,
  ready: 2,
  pending: 2,
  completed: 3,
  cancelled: 4,
};

/** Running first, then waiting, then done; failed tasks lead because they need attention. */
const taskRowOrder = (tasks: TaskDetail[]) =>
  [...tasks].sort((a, b) => ORDER[a.status] - ORDER[b.status]);

export function TaskIcon({ task }: { task: TaskDetail }) {
  return (
    <span className="mt-0.5 h-4">
      <StatusIcon status={task.status} />
      <span className="sr-only">{statusView(task.status).label}: </span>
    </span>
  );
}
TaskIcon.displayName = "TaskIcon";

/** "Waiting for 'Add wishlist API'" when a dependency is not done, else null. */
export function waitingOn(task: TaskDetail, byId: Map<string, TaskDetail>) {
  const dep = task.dependsOn.map((id) => byId.get(id)).find((t) => t && t.status !== "completed");
  return dep ? dep.title : null;
}

/** Wall clock that ticks once a second while `enabled` (the "for 1m 12s" timers). */
function useNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

const DECIDED_BY: Record<NonNullable<TaskRun["decidedBy"]>, string> = {
  rules: "Chosen automatically (rules)",
  clef: "Chosen automatically (decision model)",
};

function RunFacts({ run }: { run: TaskRun }) {
  return (
    <li className="grid gap-0.5 py-1.5">
      <span className="font-semibold">
        Attempt {run.attempt} · {modelName(run.tier)}
        {run.status === "failed" ? " · failed" : run.status === "running" ? " · running" : ""}
      </span>
      <span className="text-kumo-subtle tabular-nums">
        {plural(run.modelCalls, "model call")} · {formatNumber(run.inputTokens)} tokens in,{" "}
        {formatNumber(run.outputTokens)} out · {formatUsd(run.costUsd)} · {runDuration(run)}
      </span>
      {run.decidedBy && <span className="text-kumo-subtle">{DECIDED_BY[run.decidedBy]}</span>}
      {run.routeReasons.length > 0 && (
        <span className="text-kumo-subtle">Why this model: {run.routeReasons.join("; ")}</span>
      )}
      {run.status === "failed" && (
        <span className="text-kumo-danger">
          {(run.failureKind ?? "failure").replace(/_/g, " ")}
          {run.outcome && "reason" in run.outcome ? `: ${run.outcome.reason}` : ""}
        </span>
      )}
    </li>
  );
}

function TaskTechnical({ task }: { task: TaskDetail }) {
  return (
    <TechnicalDetails>
      <div className="grid gap-1">
        <p className="font-mono break-all text-kumo-subtle">
          {task.key} · {task.kind} · {task.complexity} · {task.id}
        </p>
        {task.semanticResources.length > 0 && (
          <p className="text-kumo-subtle">
            Areas: {task.semanticResources.map(readableArea).join(", ")}
          </p>
        )}
        {task.runs.length === 0 ? (
          <p className="text-kumo-subtle">No attempt yet.</p>
        ) : (
          <ol className="grid divide-y divide-kumo-rule">
            {[...task.runs].reverse().map((run) => (
              <RunFacts key={run.attempt} run={run} />
            ))}
          </ol>
        )}
      </div>
    </TechnicalDetails>
  );
}

function FileList({ label, paths }: { label: string; paths: { path: string; stat: string }[] }) {
  return (
    <details className="text-[13px]">
      <summary className="cursor-pointer text-kumo-link">{label}</summary>
      <ul className="mt-1 grid gap-0.5 pl-4">
        {paths.map((p) => (
          <li key={p.path} className="flex justify-between gap-3 font-mono text-[12px]">
            <span className="min-w-0 break-all">{p.path}</span>
            {p.stat && <span className="shrink-0 text-kumo-subtle tabular-nums">{p.stat}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function TaskRow({
  task,
  byId,
  progress,
  workspace,
  now,
}: {
  task: TaskDetail;
  byId: Map<string, TaskDetail>;
  progress: RunProgress | undefined;
  workspace: WorkspaceView | undefined;
  now: number;
}) {
  const run = task.runs.at(-1);
  const previous = task.runs.at(-2);
  const approach = taskApproach(task);
  const files = task.status === "completed" ? taskFiles(workspace, task.id) : null;
  let line: string;
  switch (task.status) {
    case "running": {
      const step = progress?.lastStep ? describeStep(progress.lastStep) : "Working";
      line = `${step} · for ${elapsed(progress?.startedAt ?? run?.startedAt, now)}`;
      break;
    }
    case "assigned":
      line = "Starting: the agent is reading the task.";
      break;
    case "pending": {
      const dep = waitingOn(task, byId);
      line = dep ? `Waiting for ‘${dep}’` : "Waiting.";
      break;
    }
    case "ready":
      line = "Ready, starts soon.";
      break;
    case "blocked":
      line = "Blocked: a limit or a failed job stopped this task.";
      break;
    case "completed":
      line = files ? `Done · ${filesLine(files)}` : "Done";
      break;
    case "failed":
      line = `Failed: ${failureReason(task)}`;
      break;
    default:
      line = "Cancelled.";
  }
  // A new attempt after a failure: say so, and whether a stronger model took over.
  const retry =
    task.status !== "failed" && previous?.status === "failed" && run
      ? `Attempt ${previous.attempt} failed: ${
          previous.outcome && "reason" in previous.outcome
            ? previous.outcome.reason
            : (previous.failureKind ?? "no reason recorded").replace(/_/g, " ")
        }. ${run.tier !== previous.tier ? "Retrying with a stronger model." : "Retrying."}`
      : null;

  return (
    <li className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2.5 border-b border-kumo-rule py-3 last:border-b-0">
      <TaskIcon task={task} />
      <div className="grid min-w-0 gap-1">
        <p className="text-[14px] font-semibold">{task.title}</p>
        <p
          className={
            task.status === "failed"
              ? "text-[13px] text-kumo-danger"
              : "text-[13px] text-kumo-subtle"
          }
        >
          {line}
        </p>
        {retry && <p className="text-[13px] text-kumo-warning">{retry}</p>}
        {approach && <p className="text-[13px]">Approach: {approach.summary}</p>}
        {files && files.files.length > 0 && (
          <FileList
            label="Show files"
            paths={files.files.map((f) => ({ path: f.path, stat: statLine(f) }))}
          />
        )}
        {!files && approach && approach.expectedFiles.length > 0 && (
          <FileList
            label={`Will touch ${plural(approach.expectedFiles.length, "file")}`}
            paths={approach.expectedFiles.map((path) => ({ path, stat: "" }))}
          />
        )}
        <TaskTechnical task={task} />
      </div>
    </li>
  );
}

export function TaskRows({
  tasks,
  progress,
  workspace,
}: {
  tasks: TaskDetail[];
  progress: RunProgress[];
  workspace: WorkspaceView | undefined;
}) {
  const running = tasks.some((t) => t.status === "running");
  const now = useNow(running);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return (
    <ul className="grid">
      {taskRowOrder(tasks).map((task) => {
        const attempt = task.runs.at(-1)?.attempt;
        const live = progress.find((p) => p.taskId === task.id && p.attempt === attempt);
        return (
          <TaskRow
            key={task.id}
            task={task}
            byId={byId}
            progress={live}
            workspace={workspace}
            now={now}
          />
        );
      })}
    </ul>
  );
}
TaskRows.displayName = "TaskRows";
