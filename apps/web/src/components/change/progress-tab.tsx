import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import type {
  ChangeDetail,
  ConflictDetail,
  FeedEvent,
  RunProgress,
  TaskDetail,
  WorkspaceView,
} from "../../lib/api";
import { formatDuration, formatUsd, plural, topologicalOrder } from "../../lib/format";
import { isActive, isFinished, requiredTally } from "../candidate/model";
import { ConflictCallout } from "../conflict-card";
import { StatusIcon } from "../ui/status-pill";
import { Term } from "../ui/term";
import { ApprovalStep } from "./approval-step";
import { CriteriaList, InvariantList } from "./change-overview";
import { ChecksStep } from "./checks-step";
import { type Headline, isReady, type StepId, type VersionView } from "./headline";
import { areasOf, type ChangeFileView, statLine } from "./model";
import { ShippedStep, type ShipState } from "./shipped-step";
import { TaskIcon, TaskRows, waitingOn } from "./task-rows";

/**
 * The Progress tab (docs/ux/research-2026-10-09.md 7.4, P2): five fixed steps, Planned, Agents
 * working, Checks, Your approval, Shipped. The current step is open; the others open on click.
 * A side card repeats the goal's rules, the areas, the file count and the spend.
 */

type StepState = "done" | "running" | "action" | "waiting" | "failed" | "skipped";

/** Status words for the shared icon, and the word read by screen readers. */
const STATE_ICON: Record<StepState, { status: string; word: string }> = {
  done: { status: "completed", word: "Done" },
  running: { status: "running", word: "In progress" },
  action: { status: "awaiting_approval", word: "Needs you" },
  waiting: { status: "pending", word: "Not started" },
  failed: { status: "failed", word: "Failed" },
  skipped: { status: "skipped", word: "Skipped" },
};

type StepView = {
  id: StepId;
  title: string;
  state: StepState;
  summary: ReactNode;
  duration: string | null;
  body: ReactNode;
};

const span = (from: number, to: number) =>
  Number.isFinite(from) && Number.isFinite(to) && to >= from
    ? formatDuration((to - from) / 1000)
    : null;

function Step({
  step,
  open,
  onToggle,
  last,
}: {
  step: StepView;
  open: boolean;
  onToggle: () => void;
  last: boolean;
}) {
  const bodyId = `step-${step.id}-body`;
  return (
    <li id={`step-${step.id}`} className="grid scroll-mt-20 grid-cols-[20px_minmax(0,1fr)] gap-x-3">
      <div className="flex flex-col items-center">
        <span className="grid h-7 place-items-center">
          <StatusIcon status={STATE_ICON[step.state].status} size={20} />
          <span className="sr-only">{STATE_ICON[step.state].word}</span>
        </span>
        {!last && <span aria-hidden className="w-px flex-1 bg-kumo-rule" />}
      </div>
      <div className="grid min-h-14 content-start pb-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          className="flex w-full items-start justify-between gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-accent-500"
        >
          <span className="grid min-w-0 gap-0.5">
            <span className="type-h3 leading-7">{step.title}</span>
            <span className="text-[14px] text-kumo-subtle">{step.summary}</span>
          </span>
          {step.duration && (
            <span className="shrink-0 pt-1.5 text-[12px] text-kumo-subtle tabular-nums">
              {step.duration}
            </span>
          )}
        </button>
        {open && (
          <div id={bodyId} className="mt-3 grid gap-4">
            {step.body}
          </div>
        )}
      </div>
    </li>
  );
}

function PlannedBody({
  change,
  tasks,
  compiling,
}: {
  change: ChangeDetail;
  tasks: TaskDetail[];
  compiling: boolean;
}) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return (
    <>
      <div className="grid gap-2">
        <h4 className="text-[14px] font-semibold">
          <Term k="doneWhen" />
        </h4>
        <CriteriaList items={change.acceptanceCriteria} />
      </div>
      <div className="grid gap-2">
        <h4 className="text-[14px] font-semibold">
          <Term k="mustNotChange" />
        </h4>
        <InvariantList items={change.invariants} />
      </div>
      <div className="grid gap-2">
        <h4 className="flex items-baseline justify-between gap-3 text-[14px] font-semibold">
          <Term k="tasks" />
          {tasks.length > 0 && (
            <Link
              to="/changes/$changeId/flight"
              params={{ changeId: change.id }}
              className="text-[13px] font-normal text-kumo-link hover:underline"
            >
              Show as graph
            </Link>
          )}
        </h4>
        {compiling ? (
          <p className="text-[14px] text-kumo-subtle">Splitting your goal into tasks...</p>
        ) : (
          <ol className="grid gap-1.5">
            {topologicalOrder(tasks).map((task) => {
              const dep = task.status === "completed" ? null : waitingOn(task, byId);
              return (
                <li
                  key={task.id}
                  className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2.5 text-[14px]"
                >
                  <TaskIcon task={task} />
                  <span className="min-w-0">
                    {task.title}
                    {dep && <span className="text-kumo-subtle"> · after {dep}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </>
  );
}

function SideCard({
  change,
  tasks,
  files,
  spentUsd,
}: {
  change: ChangeDetail;
  tasks: TaskDetail[];
  files: ChangeFileView;
  spentUsd: number | null;
}) {
  const areas = areasOf(tasks);
  return (
    <aside className="grid content-start gap-5 rounded-lg border border-kumo-rule p-4 text-[14px]">
      <div className="grid gap-2">
        <h3 className="font-semibold">Done when</h3>
        <CriteriaList items={change.acceptanceCriteria} />
      </div>
      <div className="grid gap-2">
        <h3 className="font-semibold">Must not change</h3>
        <InvariantList items={change.invariants} />
      </div>
      {areas.length > 0 && (
        <div className="grid gap-2">
          <h3 className="font-semibold">
            <Term k="area">Areas affected</Term>
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {areas.map((area) => (
              <li key={area} className="rounded-md bg-kumo-tint px-2 py-0.5 text-[13px]">
                {area}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-1">
        <h3 className="font-semibold">Files changed</h3>
        <p className="tabular-nums">
          {files.summary
            ? `${files.summary.files.length} (${statLine(files.summary)})`
            : files.planned.length > 0
              ? `${plural(files.planned.length, "file")} planned`
              : "None yet"}
        </p>
      </div>
      <div className="grid gap-1">
        <h3 className="font-semibold">Cost</h3>
        <p className="tabular-nums">
          {formatUsd(spentUsd ?? 0)} of {formatUsd(change.budgetUsd)}
        </p>
      </div>
    </aside>
  );
}

export function ProgressTab({
  change,
  riskTier,
  headline,
  tasks,
  conflicts,
  versions,
  progress,
  workspace,
  feed,
  files,
  spentUsd,
  run,
  ship,
  onReview,
  focusStep,
  now,
}: {
  change: ChangeDetail;
  riskTier: string | null | undefined;
  headline: Headline;
  tasks: TaskDetail[];
  conflicts: ConflictDetail[];
  versions: VersionView[];
  progress: RunProgress[];
  workspace: WorkspaceView | undefined;
  feed: FeedEvent[];
  files: ChangeFileView;
  spentUsd: number | null;
  run: { start: () => void; pending: boolean; error: string | null };
  ship: ShipState;
  onReview: () => void;
  /** "See what failed" opens and scrolls to this step; `n` repeats the request. */
  focusStep: { id: StepId; n: number } | null;
  now: number;
}) {
  const status = change.status;
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "completed").length;
  const active = tasks.filter((t) => t.runs.at(-1)?.status === "running").length;
  const anyFailed = tasks.some((t) => t.status === "failed");
  const openTasks = tasks.some((t) =>
    ["pending", "ready", "assigned", "running", "blocked"].includes(t.status),
  );
  const compiling = (status === "created" || status === "compiling") && total === 0;
  const version = headline.version;
  const risk = riskTier ? `${riskTier[0]?.toUpperCase()}${riskTier.slice(1)} risk` : null;
  const openConflicts = conflicts.filter((c) => c.state !== "resolved");

  // Step 1: Planned.
  const planned: StepView = {
    id: "planned",
    title: "Planned",
    state: compiling ? "running" : total > 0 ? "done" : status === "failed" ? "failed" : "waiting",
    summary: compiling
      ? "Splitting your goal into tasks..."
      : total > 0
        ? [`Split into ${plural(total, "task")}`, risk].filter(Boolean).join(" · ")
        : "Not started.",
    duration: null,
    body: <PlannedBody change={change} tasks={tasks} compiling={compiling} />,
  };

  // Step 2: Agents working.
  const runs = tasks.flatMap((t) => t.runs);
  const firstStart = Math.min(...runs.map((r) => Date.parse(r.startedAt)));
  const lastEnd = openTasks
    ? now
    : Math.max(...runs.map((r) => Date.parse(r.endedAt ?? r.startedAt)));
  const agents: StepView = {
    id: "agents",
    title: "Agents working",
    state:
      total === 0
        ? "waiting"
        : anyFailed && (status === "failed" || !openTasks)
          ? "failed"
          : openTasks
            ? "running"
            : "done",
    summary:
      total === 0
        ? "Not started."
        : `${done} of ${total} tasks done${active > 0 ? ` · ${plural(active, "agent")} working` : ""}`,
    duration: runs.length > 0 ? span(firstStart, lastEnd) : null,
    body:
      total === 0 ? (
        <p className="text-[14px] text-kumo-subtle">Agents start once the tasks are planned.</p>
      ) : (
        <>
          {openConflicts.map((c) => (
            <ConflictCallout key={c.id} conflict={c} />
          ))}
          <TaskRows tasks={tasks} progress={progress} workspace={workspace} />
        </>
      ),
  };

  // Step 3: Checks.
  const tasksDone = total > 0 && !openTasks && !anyFailed;
  const checking = versions.some((v) => isActive(v.candidate));
  const checksState: StepState = checking
    ? "running"
    : !version
      ? "waiting"
      : version.candidate.status === "promoted" || isReady(version)
        ? "done"
        : version.candidate.status === "rejected"
          ? "failed"
          : "waiting";
  const tally = version ? requiredTally(version.rows) : null;
  const checkEnd = version
    ? isFinished(version.candidate)
      ? Math.max(
          ...version.rows
            .map((r) => Date.parse(r.record?.completedAt ?? ""))
            .filter(Number.isFinite),
        )
      : now
    : Number.NaN;
  const checks: StepView = {
    id: "checks",
    title: "Checks",
    state: checksState,
    summary:
      !version || !tally
        ? tasksDone
          ? "Ready to run."
          : "Not yet."
        : checking
          ? `Running checks on ${versions.length > 1 ? `${versions.length} versions` : version.label}`
          : `${version.label} passed ${tally.met} of ${tally.total} required checks`,
    duration: version ? span(Date.parse(version.candidate.createdAt), checkEnd) : null,
    body: (
      <ChecksStep
        changeId={change.id}
        versions={versions}
        focus={version}
        workspace={workspace}
        tasksDone={tasksDone && !checking}
        onRunChecks={run.start}
        runPending={run.pending}
        runError={run.error}
      />
    ),
  };

  // Step 4: Your approval.
  const ready = !!version && (isReady(version) || version.candidate.status === "promoted");
  const approval = version?.candidate.approval;
  const approvalState: StepState = approval
    ? approval.decision === "granted"
      ? "done"
      : "failed"
    : !ready
      ? "waiting"
      : !version?.candidate.approvalRequired
        ? "skipped"
        : "action";
  const approvalStep: StepView = {
    id: "approval",
    title: "Your approval",
    state: approvalState,
    summary:
      approvalState === "done"
        ? "Approved"
        : approvalState === "failed"
          ? "Rejected"
          : approvalState === "skipped"
            ? "Not needed"
            : approvalState === "action"
              ? "Needs your approval"
              : "Not yet.",
    duration: null,
    body: (
      <ApprovalStep
        version={version}
        riskTier={riskTier}
        files={files.summary}
        onReview={onReview}
        busy={ship.pending}
      />
    ),
  };

  // Step 5: Shipped.
  const release = version?.candidate.release;
  const shippedState: StepState =
    ship.error || release?.status === "failed" || release?.status === "smoke_failed"
      ? "failed"
      : ship.pending ||
          status === "promoting" ||
          status === "releasing" ||
          release?.status === "queued" ||
          release?.status === "building"
        ? "running"
        : release?.status === "deployed" ||
            release?.status === "superseded" ||
            version?.candidate.status === "promoted"
          ? "done"
          : "waiting";
  const shipped: StepView = {
    id: "shipped",
    title: "Shipped",
    state: shippedState,
    summary:
      shippedState === "waiting"
        ? "Not yet."
        : shippedState === "running"
          ? "Shipping..."
          : shippedState === "failed"
            ? "Did not deploy"
            : release?.status === "deployed"
              ? "Live"
              : "Saved",
    duration: null,
    body: <ShippedStep version={version} changeStatus={status} ship={ship} feed={feed} />,
  };

  const steps = [planned, agents, checks, approvalStep, shipped];
  // The current step: the first that is not done or skipped (a failed step counts as current).
  const current = steps.find((s) => s.state !== "done" && s.state !== "skipped")?.id ?? "shipped";
  const [toggled, setToggled] = useState<Partial<Record<StepId, boolean>>>({});
  const isOpen = (id: StepId) => toggled[id] ?? (id === current || id === focusStep?.id);

  useEffect(() => {
    if (!focusStep) return;
    setToggled((t) => ({ ...t, [focusStep.id]: true }));
    document
      .getElementById(`step-${focusStep.id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusStep]);

  return (
    <div className="grid gap-7 min-[1100px]:grid-cols-[minmax(0,1fr)_320px]">
      <ol aria-label="Progress" className="grid content-start">
        {steps.map((step, i) => (
          <Step
            key={step.id}
            step={step}
            open={isOpen(step.id)}
            last={i === steps.length - 1}
            onToggle={() => setToggled((t) => ({ ...t, [step.id]: !isOpen(step.id) }))}
          />
        ))}
      </ol>
      <SideCard change={change} tasks={tasks} files={files} spentUsd={spentUsd} />
    </div>
  );
}
ProgressTab.displayName = "ProgressTab";
