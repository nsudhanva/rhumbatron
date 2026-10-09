import type { Intent, TaskDetail, TaskRun } from "../lib/api";
import { formatNumber, formatUsd, runDuration } from "../lib/format";
import { EmptyState } from "./ui/empty-state";
import { KeyValue } from "./ui/key-value";
import { StatusPill } from "./ui/status-pill";
import { Tag } from "./ui/tag";

/**
 * Task inspector beside the Work Graph (DESIGN.md 9.13, 10): repeats the selected node as text.
 * Rows under 1px rules; machine values in mono; status as a word.
 */

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
      {run.status === "failed" && (
        <p className="text-[12px] text-kumo-danger">
          <span className="font-semibold">FAIL</span> {run.failureKind ?? "failure"}
          {outcome && "reason" in outcome ? `: ${outcome.reason}` : ""}
        </p>
      )}
      {run.status === "completed" && isIntent(outcome) && (
        <div className="grid gap-2 bg-kumo-base p-3">
          <h4 className="type-label text-kumo-subtle">Intent</h4>
          <p className="text-[13px]">{outcome.summary}</p>
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

export function TaskPanel({ task }: { task: TaskDetail | undefined }) {
  if (!task) {
    return (
      <EmptyState
        what="No Task selected."
        how="Select a node in the Work Graph to see its runs and Intent."
      />
    );
  }
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-kumo-subtle">{task.key}</span>
          <StatusPill status={task.status} />
          <Tag>{task.kind}</Tag>
        </div>
        <h3 className="type-h4">{task.title}</h3>
        <p className="text-[13px] text-kumo-subtle">{task.objective}</p>
      </div>
      <KeyValue
        items={[
          { label: "Risk", value: task.riskTier },
          { label: "Complexity", value: task.complexity },
          { label: "Agent", value: task.assignedAgentId, mono: true },
          { label: "Task", value: task.id, mono: true },
        ]}
      />
      <Rows title="Semantic resources" items={task.semanticResources} mono />
      <Rows title="Acceptance criteria" items={task.acceptanceCriteria} />
      <div className="grid gap-1">
        <h4 className="type-label text-kumo-subtle">Runs</h4>
        {task.runs.length === 0 ? (
          <p className="text-[13px] text-kumo-subtle">No runs yet. The agent has not woken.</p>
        ) : (
          <ol className="grid">
            {task.runs.map((run) => (
              <Run key={run.attempt} run={run} />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
