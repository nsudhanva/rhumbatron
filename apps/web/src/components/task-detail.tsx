import { Badge, Text } from "@cloudflare/kumo";
import type { Intent, TaskDetail, TaskRun } from "../lib/api";
import { formatUsd, runDuration } from "../lib/format";
import { STATUS_STYLE } from "./work-graph";

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="grid gap-1">
      <Text as="h4" variant="secondary">
        {title}
      </Text>
      <ul className="list-disc pl-5 text-sm text-kumo-default">
        {items.map((item) => (
          <li key={item}>{item}</li>
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
    <div className="grid gap-2 rounded-lg border border-kumo-line px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Text bold>Attempt {run.attempt}</Text>
        <Badge variant="info">{run.tier}</Badge>
        <Badge
          variant={
            run.status === "completed" ? "success" : run.status === "failed" ? "error" : "warning"
          }
        >
          {run.status}
        </Badge>
        {run.decidedBy && <Badge variant="secondary">routed by {run.decidedBy}</Badge>}
      </div>
      <Text variant="secondary">
        {run.modelCalls} model calls · {run.inputTokens.toLocaleString()} in /{" "}
        {run.outputTokens.toLocaleString()} out tokens · {formatUsd(run.costUsd)} ·{" "}
        {runDuration(run)}
      </Text>
      {run.routeReasons.length > 0 && (
        <Text variant="secondary">Route reasons: {run.routeReasons.join(", ")}</Text>
      )}
      {run.status === "failed" && (
        <div className="rounded-md bg-kumo-danger-tint px-2 py-1.5 text-sm text-kumo-danger">
          {run.failureKind ?? "failure"}
          {outcome && "reason" in outcome ? `: ${outcome.reason}` : ""}
        </div>
      )}
      {run.status === "completed" && isIntent(outcome) && (
        <div className="grid gap-2">
          <Text as="h4" bold>
            Intent
          </Text>
          <Text>{outcome.summary}</Text>
          <List title="Expected files" items={outcome.expectedFiles} />
          <List title="Contract changes" items={outcome.expectedContractChanges} />
          <List title="Data changes" items={outcome.expectedDataChanges} />
          <List title="Assumptions" items={outcome.assumptions} />
          <List title="Acceptance evidence" items={outcome.acceptanceEvidence} />
        </div>
      )}
    </div>
  );
}

export function TaskPanel({ task }: { task: TaskDetail | undefined }) {
  if (!task) return <Text variant="secondary">Select a Task to see its details.</Text>;
  const style = STATUS_STYLE[task.status];
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs text-kumo-subtle">{task.key}</span>
          <Badge variant={style.variant}>{style.label}</Badge>
          <Badge variant="secondary">{task.kind}</Badge>
        </div>
        <Text as="h3" variant="heading3">
          {task.title}
        </Text>
        <Text variant="secondary">{task.objective}</Text>
      </div>
      <List title="Acceptance criteria" items={task.acceptanceCriteria} />
      <List title="Semantic resources" items={task.semanticResources} />
      <div className="grid gap-2">
        <Text as="h4" variant="secondary">
          Runs
        </Text>
        {task.runs.length === 0 ? (
          <Text variant="secondary">No runs yet.</Text>
        ) : (
          task.runs.map((run) => <Run key={run.attempt} run={run} />)
        )}
      </div>
    </div>
  );
}
