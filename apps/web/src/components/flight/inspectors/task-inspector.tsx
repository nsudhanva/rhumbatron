import { cn } from "@cloudflare/kumo";
import { type ReactNode, useMemo } from "react";
import type { WorkspaceFileStat } from "../../../lib/api";
import {
  EMPTY,
  formatDuration,
  formatNumber,
  formatUsd,
  generation,
  truncate,
} from "../../../lib/format";
import { CALLS_PER_RUN } from "../../agents/activity-model";
import { DataTable, Td, Th, TRow } from "../../ui/data-table";
import { KeyValue } from "../../ui/key-value";
import { Mono } from "../../ui/mono";
import { Section } from "../../ui/page";
import { StatusPill, statusView } from "../../ui/status-pill";
import { Tag } from "../../ui/tag";
import { useFlight } from "../flight-context";
import { providerName, type TaskState, taskOfAgent } from "../flight-model";
import { type EntityRef, useFlightStore, useIsHighlighted } from "../flight-store";
import { EntityHover } from "../hover-preview";
import { useClock, useLiveInstant } from "../panels/lanes/timeline";

/**
 * Task and Agent inspectors: the deep view of one agent's execution. Every fact comes from the
 * fold at the time-machine instant (`useFlight().state`): attempts and usage from Task runs
 * (`/v1/changes/:id/tasks`), live calls and the last step from run progress, Intent from the
 * attempt outcome, files and ChangeSets from the Workspace view, route reasons from Decision
 * Receipts. A value the API does not record reads "not recorded", never a guess.
 */

/** A compact button that selects an entity everywhere (and previews it on hover). */
function RefButton({
  entity,
  children,
  label,
  className,
}: {
  entity: EntityRef;
  children: ReactNode;
  /** Screen-reader-only words after the visible text (the name starts with what is shown). */
  label?: string;
  className?: string;
}) {
  const { selected } = useIsHighlighted(entity);
  return (
    <EntityHover entity={entity}>
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => useFlightStore.getState().toggle(entity)}
        className={cn(
          "inline-flex min-h-6 max-w-full items-center gap-1.5 px-1 text-left text-[12px] transition-colors duration-(--rh-dur-ui) hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-accent-500 pointer-coarse:min-h-11",
          selected && "bg-kumo-faint shadow-[inset_2px_0_0_var(--color-accent-500)]",
          className,
        )}
      >
        {children}
        {label && <span className="sr-only">, {label}</span>}
      </button>
    </EntityHover>
  );
}
RefButton.displayName = "RefButton";

function List({ children }: { children: ReactNode }) {
  return <ul className="grid min-w-0 gap-px">{children}</ul>;
}
List.displayName = "List";

function Item({ children }: { children: ReactNode }) {
  return <li className="flex min-w-0 items-center border-b border-kumo-rule py-0.5">{children}</li>;
}
Item.displayName = "Item";

function Strings({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <span className="text-kumo-subtle">{empty}</span>;
  return (
    <ul className="grid gap-1">
      {items.map((s) => (
        <li key={s}>{s}</li>
      ))}
    </ul>
  );
}
Strings.displayName = "Strings";

export function TaskInspector({ entity }: { entity: EntityRef }) {
  const { state } = useFlight();
  const task = state.tasks[entity.id];
  if (!task) {
    return (
      <p className="text-[13px] text-kumo-subtle">
        Task <Mono>{entity.id}</Mono> is not part of this Change at this instant.
      </p>
    );
  }
  return (
    <div className="grid min-w-0 gap-6">
      <TaskHeader task={task} />
      <TaskBody task={task} />
    </div>
  );
}
TaskInspector.displayName = "TaskInspector";

export function AgentInspector({ entity }: { entity: EntityRef }) {
  const { state } = useFlight();
  const task = taskOfAgent(state, entity.id);
  if (!task) {
    const claims = state.claims.filter((c) => c.agentId === entity.id);
    return (
      <div className="grid min-w-0 gap-4">
        <p className="text-[13px]">
          <span className="font-semibold">This agent has no Task in this Change.</span>{" "}
          <span className="text-kumo-subtle">
            Agent <Mono>{entity.id}</Mono>.
          </span>
        </p>
        <Section as="h3" label="Claims" meta={formatNumber(claims.length)}>
          {claims.length === 0 ? (
            <p className="text-[12px] text-kumo-subtle">No Claim recorded for this agent.</p>
          ) : (
            <List>
              {claims.map((c) => (
                <Item key={c.claimId}>
                  <RefButton entity={{ kind: "resource", id: c.resource }}>
                    <Mono truncate>{c.resource}</Mono>
                  </RefButton>
                  <span className="ml-auto shrink-0 pl-2">
                    <StatusPill
                      status={c.status}
                      label={c.status === "active" ? "Held" : statusView(c.status).label}
                      family={
                        c.status === "active"
                          ? "active"
                          : c.status === "expired"
                            ? "attention"
                            : "idle"
                      }
                    />
                  </span>
                </Item>
              ))}
            </List>
          )}
        </Section>
      </div>
    );
  }
  const run = task.running ?? task.runs[task.runs.length - 1] ?? null;
  const tier = task.running?.tier ?? task.lane.tier;
  const active = ["running", "assigned"].includes(task.status);
  return (
    <div className="grid min-w-0 gap-6">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Mono className="text-[13px] font-semibold">{entity.id}</Mono>
          <StatusPill
            status={active ? "running" : "sleeping"}
            label={active ? "Active" : "Asleep"}
          />
          {task.source === "fixture" && <Tag variant="outline">fixture</Tag>}
        </div>
        <KeyValue
          items={[
            { label: "Role", value: task.kind },
            {
              label: "Model",
              value: tier
                ? `${tier}${providerName(run?.provider ?? null) ? ` · ${providerName(run?.provider ?? null)}` : ""}`
                : null,
            },
            {
              label: "Task",
              value: (
                <RefButton entity={{ kind: "task", id: task.id }}>
                  <Mono>{task.key}</Mono> {truncate(task.title, 60)}
                </RefButton>
              ),
            },
          ]}
        />
      </div>
      <TaskBody task={task} />
    </div>
  );
}
AgentInspector.displayName = "AgentInspector";

function TaskHeader({ task }: { task: TaskState }) {
  const { state } = useFlight();
  const clock = useClock();
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Mono className="text-[13px] font-semibold">{task.key}</Mono>
        <StatusPill status={task.status} />
        <Tag>{task.kind}</Tag>
        <Tag
          variant={task.riskTier === "high" || task.riskTier === "critical" ? "outline" : "neutral"}
        >
          Risk {task.riskTier}
        </Tag>
        <Tag>{task.complexity}</Tag>
        {task.critical && <Tag variant="outline">Critical path</Tag>}
        {task.source === "fixture" && <Tag variant="outline">fixture</Tag>}
      </div>
      <KeyValue
        items={[
          {
            label: "Agent",
            value: task.agentId ? (
              <RefButton entity={{ kind: "agent", id: task.agentId }}>
                <Mono truncate>{task.agentId}</Mono>
              </RefButton>
            ) : (
              "not assigned"
            ),
          },
          {
            label: "Source",
            value:
              task.source === "fixture"
                ? "Wishlist fixture (not a model run)"
                : task.source === "model"
                  ? "Model run"
                  : task.source,
          },
          {
            label: "Resources",
            value:
              task.semanticResources.length > 0 ? (
                <span className="flex flex-wrap gap-1">
                  {task.semanticResources.map((r) => (
                    <RefButton key={r} entity={{ kind: "resource", id: r }}>
                      <Mono>{r}</Mono>
                    </RefButton>
                  ))}
                </span>
              ) : null,
          },
          { label: "Layer", value: `${task.layer} of the Work Graph` },
          { label: "At", value: <Mono>{clock(state.at)}</Mono> },
        ]}
      />
    </div>
  );
}
TaskHeader.displayName = "TaskHeader";

function TaskBody({ task }: { task: TaskState }) {
  return (
    <>
      {task.running && <NowBlock task={task} />}
      <AttemptsBlock task={task} />
      <IntentBlock task={task} />
      <FilesBlock task={task} />
      <DependenciesBlock task={task} />
      <LinksBlock task={task} />
      <FactsBlock task={task} />
      <ObjectiveBlock task={task} />
    </>
  );
}
TaskBody.displayName = "TaskBody";

function NowBlock({ task }: { task: TaskState }) {
  const { state } = useFlight();
  const run = task.running;
  const instant = useLiveInstant();
  if (!run) return null;
  const provider = providerName(run.provider);
  const known = state.live;
  return (
    <Section as="h3" label="Now" meta={<StatusPill status="running" />}>
      <KeyValue
        items={[
          { label: "Model", value: `${run.tier}${provider ? ` · ${provider}` : ""}` },
          { label: "Attempt", value: formatNumber(run.attempt) },
          {
            label: "Last step",
            value: known
              ? (run.lastStep ?? "no tool step recorded yet")
              : "not recorded at this instant",
            mono: known && run.lastStep !== null,
          },
          {
            label: "Calls",
            value: known
              ? `${formatNumber(run.modelCalls)} / ${CALLS_PER_RUN[run.tier]}`
              : "not recorded at this instant",
          },
          {
            label: "Tokens",
            value: known
              ? `${formatNumber(run.inputTokens)} in · ${formatNumber(run.outputTokens)} out`
              : "not recorded at this instant",
          },
          { label: "Cost", value: known ? formatUsd(run.costUsd) : "not recorded at this instant" },
          {
            label: "Elapsed",
            value: formatDuration(Math.max(0, instant - run.startedAt) / 1000),
          },
          {
            label: "Claims",
            value:
              task.claims.length > 0 ? (
                <span className="flex flex-wrap gap-1">
                  {task.claims.map((r) => (
                    <RefButton key={r} entity={{ kind: "resource", id: r }}>
                      <Mono>{r}</Mono>
                    </RefButton>
                  ))}
                </span>
              ) : (
                "none held"
              ),
          },
        ]}
      />
    </Section>
  );
}
NowBlock.displayName = "NowBlock";

function AttemptsBlock({ task }: { task: TaskState }) {
  const { state } = useFlight();
  return (
    <Section
      as="h3"
      label="Attempts"
      meta={`${formatNumber(task.usage.modelCalls)} calls · ${formatUsd(task.usage.costUsd)}`}
    >
      {task.runs.length === 0 ? (
        <p className="text-[12px] text-kumo-subtle">No attempt has started at this instant.</p>
      ) : (
        <DataTable minWidth={760} label={`Attempts of ${task.key}`}>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Tier</Th>
              <Th>Status</Th>
              <Th numeric>Calls</Th>
              <Th numeric>In</Th>
              <Th numeric>Out</Th>
              <Th numeric>Cost</Th>
              <Th numeric>Duration</Th>
              <Th>Route</Th>
              <Th>Failure</Th>
            </tr>
          </thead>
          <tbody>
            {task.runs.map((r) => {
              const unknown = r.status === "running" && !state.live;
              const end = r.endedAt ?? state.at;
              return (
                <TRow key={r.attempt} selected={task.running?.attempt === r.attempt}>
                  <Td numeric>{r.attempt}</Td>
                  <Td>
                    <span className="font-mono text-[12px]">{r.tier}</span>
                    {r.escalatedFrom && (
                      <span className="block text-[12px] text-kumo-subtle">
                        ↑ from {r.escalatedFrom}
                      </span>
                    )}
                    {providerName(r.provider) && (
                      <span className="block text-[12px] text-kumo-subtle">
                        {providerName(r.provider)}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <StatusPill status={r.status} />
                  </Td>
                  <Td numeric>{unknown ? EMPTY : formatNumber(r.modelCalls)}</Td>
                  <Td numeric>{unknown ? EMPTY : formatNumber(r.inputTokens)}</Td>
                  <Td numeric>{unknown ? EMPTY : formatNumber(r.outputTokens)}</Td>
                  <Td numeric>{unknown ? EMPTY : formatUsd(r.costUsd)}</Td>
                  <Td numeric>{formatDuration(Math.max(0, end - r.startedAt) / 1000)}</Td>
                  <Td className="max-w-[220px]">
                    <RefButton
                      entity={{ kind: "decision", id: `route:${task.id}:${r.attempt}` }}
                      label={`Route decision of attempt ${r.attempt}`}
                    >
                      <span className="min-w-0">
                        <span className="font-mono text-[12px] text-kumo-subtle">
                          {r.decidedBy ?? "not recorded"}
                        </span>
                        {r.routeReasons.length > 0 && (
                          <span className="block truncate" title={r.routeReasons.join("; ")}>
                            {r.routeReasons.join("; ")}
                          </span>
                        )}
                      </span>
                    </RefButton>
                  </Td>
                  <Td className="max-w-[220px]">
                    {r.failureKind ? (
                      <span className="grid">
                        <span className="font-mono text-[12px] text-kumo-danger">
                          {r.failureKind}
                        </span>
                        {r.failureReason && (
                          <span className="truncate text-[12px]" title={r.failureReason}>
                            {r.failureReason}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-kumo-subtle">{EMPTY}</span>
                    )}
                  </Td>
                </TRow>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </Section>
  );
}
AttemptsBlock.displayName = "AttemptsBlock";

function IntentBlock({ task }: { task: TaskState }) {
  const intent = task.intent;
  return (
    <Section as="h3" label="Intent">
      {!intent ? (
        <p className="text-[12px] text-kumo-subtle">
          No Intent declared at this instant. An agent declares it when an attempt completes.
        </p>
      ) : (
        <div className="grid gap-3">
          <p className="text-[13px]">{intent.summary}</p>
          <KeyValue
            items={[
              {
                label: "Expected files",
                value:
                  intent.expectedFiles.length > 0 ? (
                    <span className="grid justify-items-start">
                      {intent.expectedFiles.map((f) => (
                        <RefButton key={f} entity={{ kind: "file", id: f }}>
                          <Mono truncate>{f}</Mono>
                        </RefButton>
                      ))}
                    </span>
                  ) : null,
              },
              {
                label: "Contracts",
                value: <Strings items={intent.expectedContractChanges} empty="none expected" />,
              },
              {
                label: "Data",
                value: <Strings items={intent.expectedDataChanges} empty="none expected" />,
              },
              {
                label: "Assumptions",
                value: <Strings items={intent.assumptions} empty="none stated" />,
              },
              {
                label: "Evidence",
                value: <Strings items={intent.acceptanceEvidence} empty="none named" />,
              },
            ]}
          />
        </div>
      )}
    </Section>
  );
}
IntentBlock.displayName = "IntentBlock";

type FileRow = {
  path: string;
  expected: boolean;
  stat: WorkspaceFileStat | null;
  adds: number | null;
  dels: number | null;
  contended: boolean;
};

function FilesBlock({ task }: { task: TaskState }) {
  const { state } = useFlight();
  const rows = useMemo(() => {
    const map = new Map<string, FileRow>();
    for (const path of task.files.expected) {
      map.set(path, { path, expected: true, stat: null, adds: null, dels: null, contended: false });
    }
    for (const stat of task.files.changed) {
      const row = map.get(stat.path) ?? {
        path: stat.path,
        expected: false,
        stat: null,
        adds: null,
        dels: null,
        contended: false,
      };
      row.stat = stat;
      if (stat.adds !== null) row.adds = (row.adds ?? 0) + stat.adds;
      if (stat.dels !== null) row.dels = (row.dels ?? 0) + stat.dels;
      map.set(stat.path, row);
    }
    for (const row of map.values()) {
      row.contended = state.files.find((f) => f.path === row.path)?.contended ?? false;
    }
    return [...map.values()].sort(
      (a, b) => Number(b.stat !== null) - Number(a.stat !== null) || a.path.localeCompare(b.path),
    );
  }, [task, state.files]);
  const changed = rows.filter((r) => r.stat).length;
  return (
    <Section
      as="h3"
      label="Files"
      meta={`${formatNumber(changed)} changed · ${formatNumber(task.files.expected.length)} expected`}
    >
      {rows.length === 0 ? (
        <p className="text-[12px] text-kumo-subtle">No file expected or changed at this instant.</p>
      ) : (
        <List>
          {rows.map((r) => (
            <Item key={r.path}>
              <RefButton entity={{ kind: "file", id: r.path }} className="min-w-0 flex-1">
                <Mono truncate>{r.path}</Mono>
              </RefButton>
              <span className="flex shrink-0 items-center gap-2 pl-2 font-mono text-[12px] tabular-nums">
                {r.contended && (
                  <span
                    className="bg-kumo-warning-tint px-1 text-kumo-warning"
                    title="More than one Task changed this file"
                  >
                    contended
                  </span>
                )}
                {r.stat ? (
                  r.stat.binary ? (
                    <span className="text-kumo-subtle">binary</span>
                  ) : (
                    <span title={r.stat.exact ? undefined : "Split from a scaled git stat bar"}>
                      <span className="text-kumo-success">+{r.adds ?? EMPTY}</span>{" "}
                      <span className="text-kumo-danger">−{r.dels ?? EMPTY}</span>
                      {!r.stat.exact && <span className="text-kumo-subtle"> ~</span>}
                    </span>
                  )
                ) : (
                  <span className="text-kumo-subtle">expected, not changed</span>
                )}
                {r.stat && !r.expected && <span className="text-kumo-subtle">unplanned</span>}
              </span>
            </Item>
          ))}
        </List>
      )}
    </Section>
  );
}
FilesBlock.displayName = "FilesBlock";

function DependenciesBlock({ task }: { task: TaskState }) {
  const { state } = useFlight();
  const row = (id: string, edge: string, waiting: boolean) => {
    const t = state.tasks[id];
    return (
      <Item key={edge}>
        <RefButton entity={{ kind: "dependency", id: edge }} className="min-w-0 flex-1">
          <Mono>{t?.key ?? id}</Mono>
          <span className="truncate">{t?.title ?? ""}</span>
        </RefButton>
        <span className="shrink-0 pl-2">
          {waiting ? (
            <StatusPill status="blocked" label="Waiting on" family="attention" />
          ) : (
            <StatusPill status={t?.status ?? "pending"} />
          )}
        </span>
      </Item>
    );
  };
  return (
    <Section
      as="h3"
      label="Dependencies"
      meta={
        task.blockedBy.length > 0 ? `${formatNumber(task.blockedBy.length)} blocking` : undefined
      }
    >
      <div className="grid gap-3">
        <div className="grid gap-1">
          <p className="type-label text-kumo-subtle">Depends on</p>
          {task.dependsOn.length === 0 ? (
            <p className="text-[12px] text-kumo-subtle">No dependency. Ready from the start.</p>
          ) : (
            <List>
              {task.dependsOn.map((d) => row(d, `${d}->${task.id}`, task.blockedBy.includes(d)))}
            </List>
          )}
        </div>
        <div className="grid gap-1">
          <p className="type-label text-kumo-subtle">Dependents</p>
          {task.dependents.length === 0 ? (
            <p className="text-[12px] text-kumo-subtle">No Task waits on this one.</p>
          ) : (
            <List>{task.dependents.map((d) => row(d, `${task.id}->${d}`, false))}</List>
          )}
        </div>
      </div>
    </Section>
  );
}
DependenciesBlock.displayName = "DependenciesBlock";

function LinksBlock({ task }: { task: TaskState }) {
  const { state } = useFlight();
  const conflicts = state.conflicts.filter((c) => task.conflictIds.includes(c.id));
  return (
    <>
      <Section as="h3" label="ChangeSets" meta={formatNumber(task.changeSets.length)}>
        {task.changeSets.length === 0 ? (
          <p className="text-[12px] text-kumo-subtle">No ChangeSet published at this instant.</p>
        ) : (
          <List>
            {task.changeSets.map((cs) => (
              <Item key={cs.id}>
                <RefButton entity={{ kind: "changeset", id: cs.id }} className="min-w-0 flex-1">
                  <Mono>{cs.commit.slice(0, 7)}</Mono>
                  <Mono subtle truncate>
                    {cs.id}
                  </Mono>
                </RefButton>
                <span className="shrink-0 pl-2 font-mono text-[12px] tabular-nums">
                  {formatNumber(cs.files.length)} files{" "}
                  <span className="text-kumo-success">+{cs.insertions}</span>{" "}
                  <span className="text-kumo-danger">−{cs.deletions}</span>
                </span>
              </Item>
            ))}
          </List>
        )}
      </Section>
      <Section as="h3" label="Candidates" meta={formatNumber(task.candidateIds.length)}>
        {task.candidateIds.length === 0 ? (
          <p className="text-[12px] text-kumo-subtle">
            No Candidate composes this Task's work at this instant.
          </p>
        ) : (
          <List>
            {task.candidateIds.map((id) => {
              const c = state.candidates[id];
              return (
                <Item key={id}>
                  <RefButton entity={{ kind: "candidate", id }} className="min-w-0 flex-1">
                    <span className="font-semibold">{c?.name ?? id}</span>
                    {c?.promotedGeneration != null && (
                      <Mono subtle>→ {generation(c.promotedGeneration)}</Mono>
                    )}
                  </RefButton>
                  <span className="shrink-0 pl-2">
                    <StatusPill status={c?.status ?? "pending"} />
                  </span>
                </Item>
              );
            })}
          </List>
        )}
      </Section>
      <Section as="h3" label="Conflicts" meta={formatNumber(conflicts.length)}>
        {conflicts.length === 0 ? (
          <p className="text-[12px] text-kumo-subtle">No conflict involves this Task.</p>
        ) : (
          <List>
            {conflicts.map((c) => {
              const other = c.taskIds.find((id) => id !== task.id);
              return (
                <Item key={c.id}>
                  <RefButton entity={{ kind: "conflict", id: c.id }} className="min-w-0 flex-1">
                    <Mono truncate>{c.resource}</Mono>
                    <span className="shrink-0 text-kumo-subtle">
                      with {state.tasks[other ?? ""]?.key ?? other}
                    </span>
                  </RefButton>
                  <span className="shrink-0 pl-2">
                    <StatusPill status={c.open ? c.state : "resolved"} />
                  </span>
                </Item>
              );
            })}
          </List>
        )}
      </Section>
    </>
  );
}
LinksBlock.displayName = "LinksBlock";

function FactsBlock({ task }: { task: TaskState }) {
  const { state } = useFlight();
  const clock = useClock();
  const facts = useMemo(
    () =>
      state.events
        .filter(
          (e) =>
            ("laneId" in e && e.laneId === task.id) ||
            (e.kind === "challenge" && (e.fromLaneId === task.id || e.toLaneId === task.id)),
        )
        .slice(-10)
        .reverse(),
    [state.events, task.id],
  );
  return (
    <Section as="h3" label="Recent facts" meta={`newest ${formatNumber(facts.length)}`}>
      {facts.length === 0 ? (
        <p className="text-[12px] text-kumo-subtle">No fact recorded for this lane yet.</p>
      ) : (
        <List>
          {facts.map((e) => (
            <Item key={e.id}>
              <RefButton entity={{ kind: "event", id: e.id }} className="min-w-0 flex-1">
                <Mono subtle className="shrink-0">
                  {clock(e.at)}
                </Mono>
                <Mono className="shrink-0 font-semibold">{e.type}</Mono>
                <span className="truncate" title={e.detail}>
                  {e.detail}
                </span>
              </RefButton>
            </Item>
          ))}
        </List>
      )}
    </Section>
  );
}
FactsBlock.displayName = "FactsBlock";

function ObjectiveBlock({ task }: { task: TaskState }) {
  const { model } = useFlight();
  const criteria = model.input.tasks.find((t) => t.id === task.id)?.acceptanceCriteria ?? [];
  return (
    <details className="group border-t border-kumo-rule pt-2">
      <summary className="w-fit cursor-pointer text-[12px] text-kumo-link">
        Objective and acceptance criteria
      </summary>
      <div className="mt-2 grid gap-2 text-[13px]">
        <p>{task.objective}</p>
        <Strings items={criteria} empty="No acceptance criteria recorded." />
      </div>
    </details>
  );
}
ObjectiveBlock.displayName = "ObjectiveBlock";
