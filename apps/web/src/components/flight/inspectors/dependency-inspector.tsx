import { Button, cn } from "@cloudflare/kumo";
import { useMemo } from "react";
import { formatClock, formatNumber, formatUsd } from "../../../lib/format";
import { type ActivityEvent, CALLS_PER_RUN } from "../../agents/activity-model";
import { EmptyState } from "../../ui/empty-state";
import { KeyValue } from "../../ui/key-value";
import { Mono } from "../../ui/mono";
import { Section } from "../../ui/page";
import { StatusPill, statusView } from "../../ui/status-pill";
import { Tag } from "../../ui/tag";
import { useFlight } from "../flight-context";
import { type DependencyState, providerName, type TaskState } from "../flight-model";
import { type EntityRef, useFlightStore } from "../flight-store";
import { describeDependency, shownRun } from "../panels/dag/layout";

/**
 * Dependency inspector: why one Work Graph edge (`${fromTaskId}->${toTaskId}`) blocks, or did.
 * Reads the folded state only: the upstream Task's running attempt and last fact, the downstream
 * Task's other open dependencies, the critical path flag and the facts recorded on both lanes.
 */

const EDGE_STATUS: Record<DependencyState["status"], { status: string; label: string }> = {
  blocking: { status: "waiting", label: "Waiting" },
  done: { status: "completed", label: "Done" },
  failed: { status: "failed", label: "Fail" },
  idle: { status: "idle", label: "Idle" },
};

const select = (ref: EntityRef) => useFlightStore.getState().select(ref);
const clock = (at: number) => formatClock(new Date(at).toISOString());

/** Lane ids a fact is about (conflict facts name two). */
function lanesOf(event: ActivityEvent): string[] {
  if (event.kind === "challenge") return [event.fromLaneId, event.toLaneId];
  if ("laneId" in event && event.laneId) return [event.laneId];
  return [];
}

export function DependencyInspector({ entity }: { entity: EntityRef }) {
  const { state } = useFlight();
  const [fromId = "", toId = ""] = entity.id.split("->");
  const dep = state.dependencies.find((d) => d.id === entity.id);
  const from = state.tasks[fromId];
  const to = state.tasks[toId];

  const facts = useMemo(() => {
    const lanes = new Set([fromId, toId]);
    const out: ActivityEvent[] = [];
    for (let i = state.events.length - 1; i >= 0 && out.length < 8; i--) {
      const event = state.events[i];
      if (event && lanesOf(event).some((id) => lanes.has(id))) out.push(event);
    }
    return out;
  }, [state.events, fromId, toId]);

  if (!dep || !from || !to) {
    return (
      <EmptyState
        what="This dependency is not in the Work Graph at this instant."
        how="Move the time machine forward or select another edge."
      />
    );
  }

  const edge = EDGE_STATUS[dep.status];
  const others = to.blockedBy.filter((id) => id !== from.id);

  return (
    <div className="grid gap-5 text-[13px]">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={edge.status} label={edge.label} />
          {dep.critical && <Tag>Critical path</Tag>}
        </div>
        <p>{describeDependency(state, dep)}</p>
      </div>

      <Section as="h3" label={`Upstream · ${from.key}`}>
        <TaskFacts task={from} live={state.live} />
      </Section>

      <Section as="h3" label={`Downstream · ${to.key}`}>
        <KeyValue
          items={[
            { label: "Task", value: to.title },
            { label: "Status", value: <StatusPill status={to.status} /> },
            {
              label: "Also waits on",
              value:
                others.length === 0 ? (
                  <span className="text-kumo-subtle">
                    {dep.status === "blocking" ? `Only ${from.key}` : "Nothing else"}
                  </span>
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {others.map((id) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => select({ kind: "dependency", id: `${id}->${to.id}` })}
                        className="min-h-6 cursor-pointer px-1 font-mono text-[12px] hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                      >
                        {state.tasks[id]?.key ?? id}{" "}
                        <span className="text-kumo-subtle">
                          {statusView(state.tasks[id]?.status ?? "pending").label}
                        </span>
                      </button>
                    ))}
                  </span>
                ),
            },
            {
              label: "Dependencies",
              value: `${formatNumber(to.dependsOn.length - to.blockedBy.length)} of ${formatNumber(to.dependsOn.length)} done`,
            },
          ]}
        />
      </Section>

      <Section
        as="h3"
        label="Recorded facts"
        meta={facts.length > 0 ? `newest ${formatNumber(facts.length)}` : undefined}
      >
        {facts.length === 0 ? (
          <p className="text-kumo-subtle">
            No fact about {from.key} or {to.key} is recorded yet.
          </p>
        ) : (
          <ol className="grid">
            {facts.map((event) => (
              <li key={event.id} className="border-b border-kumo-rule last:border-b-0">
                <button
                  type="button"
                  onClick={() => select({ kind: "event", id: event.id })}
                  className="grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-x-3 py-1.5 text-left hover:bg-kumo-row-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500"
                >
                  <Mono subtle>{clock(event.at)}</Mono>
                  <span className="min-w-0">
                    <Mono className="mr-2">{event.type}</Mono>
                    <span className="text-[12px]">{event.detail}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => select({ kind: "task", id: from.id })}>
          Select {from.key}
        </Button>
        <Button size="sm" onClick={() => select({ kind: "task", id: to.id })}>
          Select {to.key}
        </Button>
      </div>
    </div>
  );
}
DependencyInspector.displayName = "DependencyInspector";

function TaskFacts({ task, live }: { task: TaskState; live: boolean }) {
  const run = shownRun(task);
  const running = task.running;
  const cap = running ? CALLS_PER_RUN[running.tier] : null;
  const provider = run ? providerName(run.provider) : null;
  const failed = task.status === "failed" || task.status === "blocked";
  const lastFailed = [...task.runs].reverse().find((r) => r.status === "failed") ?? null;
  return (
    <div className="grid gap-2">
      <KeyValue
        items={[
          { label: "Task", value: task.title },
          { label: "Status", value: <StatusPill status={task.status} /> },
          {
            label: running ? "Running" : "Last attempt",
            value: run ? (
              <span className="font-mono text-[12px]">
                attempt {run.attempt} on {run.tier}
                {provider ? ` · ${provider}` : ""}
                {run.escalatedFrom ? ` · ↑ from ${run.escalatedFrom}` : ""}
              </span>
            ) : (
              <span className="text-kumo-subtle">No attempt started</span>
            ),
          },
          ...(running && cap
            ? [
                {
                  label: "Model calls",
                  value: (
                    <span className="grid gap-1">
                      <span className="font-mono text-[12px] tabular-nums">
                        {live
                          ? `${formatNumber(running.modelCalls)} / ${formatNumber(cap)}`
                          : "Not recorded at this instant"}
                      </span>
                      {live && (
                        <span className="h-0.5 w-full bg-kumo-recessed">
                          <span
                            className="rh-lane-progress block"
                            style={{ width: `${Math.min(100, (running.modelCalls / cap) * 100)}%` }}
                          />
                        </span>
                      )}
                    </span>
                  ),
                },
                {
                  label: "Last step",
                  value: live ? (
                    (running.lastStep ?? <span className="text-kumo-subtle">Not recorded</span>)
                  ) : (
                    <span className="text-kumo-subtle">Live only</span>
                  ),
                },
              ]
            : []),
          ...(run && !running
            ? [
                {
                  label: "Usage",
                  value: `${formatNumber(task.usage.modelCalls)} calls · ${formatUsd(task.usage.costUsd)}`,
                },
              ]
            : []),
          {
            label: "Last fact",
            value: task.lastEvent ? (
              <span>
                <Mono subtle className="mr-2">
                  {clock(task.lastEvent.at)}
                </Mono>
                {task.lastEvent.detail}
              </span>
            ) : (
              <span className="text-kumo-subtle">None recorded</span>
            ),
          },
        ]}
      />
      {failed && (
        <div className={cn("border-l-2 border-accent-500 bg-accent-100 px-3 py-2 text-[12px]")}>
          <p className="font-semibold text-kumo-danger">
            {statusView(task.status).label}
            {lastFailed?.failureKind ? ` · ${lastFailed.failureKind.replace(/_/g, " ")}` : ""}
          </p>
          <p>{lastFailed?.failureReason ?? "The failure reason is not recorded."}</p>
        </div>
      )}
    </div>
  );
}
TaskFacts.displayName = "TaskFacts";
