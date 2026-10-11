import type { ChangeSetAttribution, ClaimState, Intent, TaskDetail, TaskRun } from "../lib/api";
import { formatNumber, formatUsd, latestRun, runDuration, timeAgo } from "../lib/format";
import { Disclosure } from "./change/disclosure";
import { EmptyState } from "./ui/empty-state";
import { KeyValue } from "./ui/key-value";
import { StatusPill } from "./ui/status-pill";
import { Tag } from "./ui/tag";

/**
 * Task inspector beside the Work Graph (DESIGN.md 9.13, 10): repeats the selected node as text.
 * First what a person needs (objective, status, agent and model, files changed, result), then
 * the machine record (route, tokens, claims, IDs) behind "Details".
 */

const TIER: Record<TaskRun["tier"], string> = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" };

function Rows({ title, items, mono }: { title: string; items: string[]; mono?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div className="grid gap-1">
      <h4 className="type-label text-kumo-subtle">{title}</h4>
      <ul className="grid">
        {items.map((item) => (
          <li
            key={item}
            className={
              mono
                ? "border-b border-kumo-rule py-1.5 font-mono text-[11px] break-all"
                : "border-b border-kumo-rule py-1.5 text-[13px]"
            }
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function isIntent(outcome: TaskRun["outcome"]): outcome is Intent {
  return outcome !== null && "summary" in outcome;
}

/** The latest result in one or two lines. */
function Result({ run }: { run: TaskRun | undefined }) {
  if (!run) {
    return <p className="text-[13px] text-kumo-subtle">Not started. The agent has not woken.</p>;
  }
  if (run.status === "running") {
    return (
      <p className="text-[13px]">
        Working · attempt {run.attempt} · {formatNumber(run.modelCalls)} model{" "}
        {run.modelCalls === 1 ? "call" : "calls"} so far
      </p>
    );
  }
  if (run.status === "failed") {
    const reason = run.outcome && "reason" in run.outcome ? run.outcome.reason : null;
    return (
      <p className="text-[13px] text-kumo-danger">
        <span className="font-semibold">FAIL</span>{" "}
        {reason ?? run.failureKind ?? "no reason recorded"}
      </p>
    );
  }
  if (isIntent(run.outcome))
    return <p className="text-[13px] text-pretty">{run.outcome.summary}</p>;
  return <p className="text-[13px]">Completed.</p>;
}

/** Files the Task's ChangeSets changed; before any ChangeSet, the files the Intent planned. */
function Files({
  changeSets,
  run,
}: {
  changeSets: ChangeSetAttribution[];
  run: TaskRun | undefined;
}) {
  const changed = [...new Set(changeSets.flatMap((s) => s.files))].sort();
  if (changed.length > 0) return <Rows title="Files changed" items={changed} mono />;
  const planned = run && isIntent(run.outcome) ? run.outcome.expectedFiles : [];
  if (planned.length > 0) return <Rows title="Files planned" items={planned} mono />;
  return null;
}

function Run({ run }: { run: TaskRun }) {
  const outcome = run.outcome;
  return (
    <li className="grid gap-2 border-b border-kumo-rule py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold">Attempt {run.attempt}</span>
        <Tag className="font-mono">{run.tier}</Tag>
        {run.decidedBy && (
          <span className="font-mono text-[11px] text-kumo-subtle">routed by {run.decidedBy}</span>
        )}
        <StatusPill status={run.status} className="ml-auto" />
      </div>
      <p className="font-mono text-[11px] text-kumo-subtle tabular-nums">
        {formatNumber(run.modelCalls)} calls · {formatNumber(run.inputTokens)} in /{" "}
        {formatNumber(run.outputTokens)} out · {formatUsd(run.costUsd)} · {runDuration(run)}
      </p>
      {run.routeReasons.length > 0 && (
        <p className="text-[12px] text-kumo-subtle">Route: {run.routeReasons.join(" · ")}</p>
      )}
      {run.status === "failed" && run.failureKind && (
        <p className="font-mono text-[11px] text-kumo-danger">{run.failureKind}</p>
      )}
      {run.status === "completed" && isIntent(outcome) && (
        <div className="grid gap-2 bg-kumo-base p-3">
          <h4 className="type-label text-kumo-subtle">Intent</h4>
          <Rows title="Expected files" items={outcome.expectedFiles} mono />
          <Rows title="Contract changes" items={outcome.expectedContractChanges} />
          <Rows title="Data changes" items={outcome.expectedDataChanges} />
          <Rows title="Assumptions" items={outcome.assumptions} />
          <Rows title="Acceptance evidence" items={outcome.acceptanceEvidence} />
        </div>
      )}
    </li>
  );
}

export function TaskPanel({
  task,
  changeSets = [],
  claims = [],
}: {
  task: TaskDetail | undefined;
  /** ChangeSets this Task published. */
  changeSets?: ChangeSetAttribution[];
  /** Claims held by this Task's agent. */
  claims?: ClaimState[];
}) {
  if (!task) {
    return (
      <EmptyState
        what="No Task selected."
        how="Select a node in the Work Graph to see what it did."
      />
    );
  }
  const run = latestRun(task);
  const spent = task.runs.reduce((sum, r) => sum + r.costUsd, 0);
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-kumo-subtle">{task.key}</span>
          <StatusPill status={task.status} />
        </div>
        <h3 className="type-h4">{task.title}</h3>
        <p className="text-[13px] text-pretty">{task.objective}</p>
      </div>

      <KeyValue
        items={[
          {
            label: "Agent",
            value: `${task.kind}${run ? ` · ${TIER[run.tier]}` : ""}${
              task.runs.length > 1 ? ` · ${formatNumber(task.runs.length)} attempts` : ""
            }`,
          },
          { label: "Spent", value: task.runs.length > 0 ? formatUsd(spent) : null, mono: true },
        ]}
      />

      <div className="grid gap-1">
        <h4 className="type-label text-kumo-subtle">Result</h4>
        <Result run={run} />
      </div>

      <Files changeSets={changeSets} run={run} />

      <Disclosure label="Details" className="border-t-2 border-kumo-divider pt-1">
        <KeyValue
          items={[
            { label: "Task", value: task.id, mono: true },
            { label: "Agent", value: task.assignedAgentId, mono: true },
            { label: "Risk", value: task.riskTier },
            { label: "Complexity", value: task.complexity },
            {
              label: "ChangeSets",
              value: changeSets.length > 0 ? changeSets.map((s) => s.id).join(" · ") : null,
              mono: true,
            },
          ]}
        />
        <Rows title="Acceptance criteria" items={task.acceptanceCriteria} />
        <Rows title="Semantic resources" items={task.semanticResources} mono />
        {claims.length > 0 && (
          <div className="grid gap-1">
            <h4 className="type-label text-kumo-subtle">Claims</h4>
            <ul className="grid">
              {claims.map((c) => (
                <li
                  key={c.claimId}
                  className="flex flex-wrap items-center gap-2 border-b border-kumo-rule py-1.5 text-[12px]"
                >
                  <span className="min-w-0 flex-1 font-mono text-[11px] break-all">
                    {c.resource}
                  </span>
                  <span className="text-kumo-subtle">{timeAgo(c.updatedAt)}</span>
                  <StatusPill
                    status={c.status}
                    {...(c.status === "active" ? { label: "Held" } : {})}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
        {task.runs.length > 0 && (
          <div className="grid gap-1">
            <h4 className="type-label text-kumo-subtle">Runs</h4>
            <ol className="grid">
              {task.runs.map((r) => (
                <Run key={r.attempt} run={r} />
              ))}
            </ol>
          </div>
        )}
      </Disclosure>
    </div>
  );
}
TaskPanel.displayName = "TaskPanel";
