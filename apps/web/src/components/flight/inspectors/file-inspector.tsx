import type { ReactNode } from "react";
import { EMPTY, formatClock, formatNumber } from "../../../lib/format";
import { shortHash } from "../../candidate/model";
import { KeyValue } from "../../ui/key-value";
import { StatusPill } from "../../ui/status-pill";
import { Tag } from "../../ui/tag";
import { AddsDels } from "../../workspace-page/fork-tree";
import { useFlight } from "../flight-context";
import type { FlightState } from "../flight-model";
import type { EntityRef } from "../flight-store";
import { RefButton } from "../panels/arena/ref-button";
import { CheckDetail, DetailBlock, parseCheckRef } from "../panels/evidence/check-detail";

/**
 * Inspectors for a file, a semantic resource and a verification check (DESIGN.md 10: the
 * inspector repeats the selection's facts as text). Each reads the folded `state` at the
 * time-machine instant; facts not recorded at that instant are absent and the text says so.
 */

const clock = (ms: number | null) =>
  ms === null ? EMPTY : formatClock(new Date(ms).toISOString());

function Note({ children }: { children: ReactNode }) {
  return <p className="text-[12px] text-kumo-subtle">{children}</p>;
}
Note.displayName = "Note";

const keyOf = (state: FlightState, taskId: string | null) =>
  (taskId ? state.tasks[taskId]?.key : null) ?? taskId ?? EMPTY;

/* --------------------------------------------------------------------------------------------
 * File
 * ------------------------------------------------------------------------------------------ */

export function FileInspector({ entity }: { entity: EntityRef }) {
  const { state, model } = useFlight();
  const file = state.files.find((f) => f.path === entity.id);
  if (!file) return <Note>No recorded activity for this file.</Note>;

  const touches = [...file.touches].sort((a, b) => a.at - b.at);
  const tasks = file.taskIds.map((id) => {
    const kinds = new Set(touches.filter((t) => t.taskId === id).map((t) => t.kind));
    return {
      id,
      task: state.tasks[id],
      expected: kinds.has("expected"),
      changed: kinds.has("changed"),
    };
  });
  const changeSetIds = [
    ...new Set(touches.map((t) => t.changeSetId).filter((id): id is string => !!id)),
  ];
  const pendingExpected = tasks.filter((t) => t.expected && !t.changed);
  const changedBy = tasks.filter((t) => t.changed).length;

  return (
    <div className="grid gap-4">
      <KeyValue
        items={[
          { label: "Path", value: file.path, mono: true },
          { label: "Area", value: file.area },
          {
            label: "Contended",
            value: file.contended ? (
              <span className="text-kumo-danger">
                Yes: changed by {formatNumber(changedBy)} Tasks
              </span>
            ) : (
              "No"
            ),
          },
          {
            label: "Totals",
            value:
              changeSetIds.length > 0 ? (
                <AddsDels adds={file.adds} dels={file.dels} className="font-mono" />
              ) : (
                <span className="text-kumo-subtle">not changed yet</span>
              ),
          },
          { label: "Touches", value: formatNumber(touches.length), mono: true },
        ]}
      />

      {pendingExpected.length > 0 && (
        <ul className="grid gap-0.5 text-[12px] text-kumo-warning">
          {pendingExpected.map((t) => (
            <li key={t.id}>Expected by {t.task?.key ?? t.id}, not changed yet.</li>
          ))}
        </ul>
      )}

      <DetailBlock label="Tasks" meta={formatNumber(tasks.length)}>
        <ul className="grid grid-cols-[minmax(0,1fr)]">
          {tasks.map(({ id, task, expected, changed }) => (
            <li key={id} className="border-b border-kumo-rule">
              <RefButton
                entity={{ kind: "task", id }}
                mode="select"
                className="flex w-full items-center gap-2 px-1 py-1 text-[12px]"
              >
                <span className="font-mono font-semibold">{task?.key ?? id}</span>
                <span className="min-w-0 flex-1 truncate">{task?.title ?? ""}</span>
                <span className="shrink-0 text-[12px] text-kumo-subtle">
                  {[expected && "expected", changed && "changed"].filter(Boolean).join(", ")}
                </span>
                {task && <StatusPill status={task.status} />}
              </RefButton>
            </li>
          ))}
        </ul>
      </DetailBlock>

      <DetailBlock label="ChangeSets" meta={formatNumber(changeSetIds.length)}>
        {changeSetIds.length === 0 ? (
          <Note>No ChangeSet changed this file at the selected instant.</Note>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)]">
            {changeSetIds.map((id) => {
              const cs = model.changeSets[id];
              const stat = cs?.fileStats.find((s) => s.path === file.path);
              const owner = touches.find((t) => t.changeSetId === id)?.taskId ?? null;
              return (
                <li key={id} className="border-b border-kumo-rule">
                  <RefButton
                    entity={{ kind: "changeset", id }}
                    mode="select"
                    className="flex w-full items-center gap-2 px-1 py-1 text-[12px]"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">{id}</span>
                    <span className="shrink-0 font-mono text-[12px] text-kumo-subtle">
                      {keyOf(state, owner)} · {cs ? shortHash(cs.commit, 8) : "commit not recorded"}
                    </span>
                    <span className="shrink-0 font-mono text-[12px]">
                      <AddsDels adds={stat?.adds ?? null} dels={stat?.dels ?? null} />
                    </span>
                  </RefButton>
                </li>
              );
            })}
          </ul>
        )}
      </DetailBlock>

      <DetailBlock label="Touch timeline">
        <table className="w-full border-collapse text-left text-[12px]">
          <thead>
            <tr className="border-b border-kumo-divider text-[12px] text-kumo-subtle">
              <th scope="col" className="py-1 pr-2 font-normal">
                Time
              </th>
              <th scope="col" className="py-1 pr-2 font-normal">
                Kind
              </th>
              <th scope="col" className="py-1 pr-2 font-normal">
                Task
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                +/−
              </th>
            </tr>
          </thead>
          <tbody>
            {touches.map((t) => (
              <tr
                key={`${t.taskId}:${t.kind}:${t.changeSetId ?? ""}:${t.at}`}
                className="border-b border-kumo-rule"
              >
                <td className="py-1 pr-2 font-mono tabular-nums">{clock(t.at)}</td>
                <td className="py-1 pr-2">
                  {t.kind === "changed" ? "changed" : "expected (Intent)"}
                </td>
                <td className="py-1 pr-2 font-mono">{keyOf(state, t.taskId)}</td>
                <td className="py-1 text-right font-mono">
                  {t.kind === "changed" ? <AddsDels adds={t.adds} dels={t.dels} /> : EMPTY}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DetailBlock>
    </div>
  );
}
FileInspector.displayName = "FileInspector";

/* --------------------------------------------------------------------------------------------
 * Semantic resource
 * ------------------------------------------------------------------------------------------ */

const CLAIM_STATUS: Record<string, string> = {
  active: "active",
  released: "resolved",
  expired: "stale",
};

export function ResourceInspector({ entity }: { entity: EntityRef }) {
  const { state, model } = useFlight();
  const resource = state.resources.find((r) => r.resource === entity.id);
  if (!resource) return <Note>No recorded activity for this semantic resource.</Note>;

  const parts = resource.resource
    .split(/[:.]/)
    .filter((p) => p.length > 2)
    .map((p) => p.toLowerCase());
  const invariants = resource.protectedResource
    ? model.input.change.invariants.filter((inv) =>
        parts.some((p) => inv.toLowerCase().includes(p)),
      )
    : [];
  const claims = state.claims.filter((c) => c.resource === resource.resource);
  const active = claims.filter((c) => c.status === "active");
  const history = state.events
    .filter((e) => e.kind === "claim" && e.resource === resource.resource)
    .slice(-10)
    .reverse();
  const conflicts = state.conflicts.filter((c) => c.resource === resource.resource);
  const decisions = state.decisions.filter(
    (d) =>
      (d.subject.kind === "resource" && d.subject.id === resource.resource) ||
      d.causes.some((c) => c.ref.kind === "resource" && c.ref.id === resource.resource),
  );

  return (
    <div className="grid gap-4">
      {resource.protectedResource && (
        <div className="grid gap-1">
          <Tag variant="outline">Protected</Tag>
          {invariants.length > 0 ? (
            <ul className="grid gap-0.5 text-[12px]">
              {invariants.map((inv) => (
                <li key={inv}>{inv}</li>
              ))}
            </ul>
          ) : (
            <Note>Named in a protected invariant of the Change.</Note>
          )}
        </div>
      )}

      <DetailBlock label="Tasks on it" meta={formatNumber(resource.taskIds.length)}>
        {resource.taskIds.length === 0 ? (
          <Note>No Task declares this resource.</Note>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)]">
            {resource.taskIds.map((id) => {
              const task = state.tasks[id];
              return (
                <li key={id} className="border-b border-kumo-rule">
                  <RefButton
                    entity={{ kind: "task", id }}
                    mode="select"
                    className="flex w-full items-center gap-2 px-1 py-1 text-[12px]"
                  >
                    <span className="font-mono font-semibold">{task?.key ?? id}</span>
                    <span className="min-w-0 flex-1 truncate">{task?.title ?? ""}</span>
                    {task && <StatusPill status={task.status} />}
                  </RefButton>
                </li>
              );
            })}
          </ul>
        )}
      </DetailBlock>

      <DetailBlock label="Claims" meta={`${formatNumber(active.length)} active`}>
        {claims.length === 0 ? (
          <Note>No Claim recorded on this resource at the selected instant.</Note>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)]">
            {claims.map((c) => (
              <li
                key={c.claimId}
                className="flex items-center gap-2 border-b border-kumo-rule px-1 py-1 text-[12px]"
              >
                <span className="font-mono">{keyOf(state, c.taskId)}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-kumo-subtle">
                  {c.agentId || "agent not recorded"}
                </span>
                <span className="shrink-0 font-mono text-[12px] text-kumo-subtle tabular-nums">
                  {c.status === "active" ? "since" : "at"} {clock(c.since)}
                </span>
                <StatusPill
                  status={CLAIM_STATUS[c.status] ?? c.status}
                  label={
                    c.status === "active"
                      ? "Held"
                      : c.status === "released"
                        ? "Released"
                        : "Expired"
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </DetailBlock>

      {history.length > 0 && (
        <DetailBlock label="Claim history" meta="newest first">
          <ul className="grid grid-cols-[minmax(0,1fr)]">
            {history.map((e) => (
              <li key={e.id} className="border-b border-kumo-rule">
                <RefButton
                  entity={{ kind: "event", id: e.id }}
                  mode="select"
                  className="flex w-full items-baseline gap-2 px-1 py-1 text-[12px]"
                >
                  <span className="shrink-0 font-mono text-[12px] text-kumo-subtle tabular-nums">
                    {clock(e.at)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{e.detail}</span>
                </RefButton>
              </li>
            ))}
          </ul>
        </DetailBlock>
      )}

      <DetailBlock label="Conflicts" meta={formatNumber(conflicts.length)}>
        {conflicts.length === 0 ? (
          <Note>No conflict on this resource at the selected instant.</Note>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)]">
            {conflicts.map((c) => (
              <li key={c.id} className="border-b border-kumo-rule">
                <RefButton
                  entity={{ kind: "conflict", id: c.id }}
                  mode="select"
                  className="grid w-full gap-1 px-1 py-1.5 text-[12px]"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[12px]">
                      {keyOf(state, c.taskIds[0])} vs {keyOf(state, c.taskIds[1])}
                    </span>
                    <StatusPill status={c.state} />
                  </span>
                  <span>
                    <span className="font-mono text-[12px] text-kumo-subtle">
                      {keyOf(state, c.taskIds[0])}:
                    </span>{" "}
                    {c.statements[0]}
                  </span>
                  <span>
                    <span className="font-mono text-[12px] text-kumo-subtle">
                      {keyOf(state, c.taskIds[1])}:
                    </span>{" "}
                    {c.statements[1]}
                  </span>
                </RefButton>
              </li>
            ))}
          </ul>
        )}
      </DetailBlock>

      {decisions.length > 0 && (
        <DetailBlock label="Decisions" meta={formatNumber(decisions.length)}>
          <ul className="grid grid-cols-[minmax(0,1fr)]">
            {decisions.map((d) => (
              <li key={d.id} className="border-b border-kumo-rule">
                <RefButton
                  entity={{ kind: "decision", id: d.id }}
                  mode="select"
                  className="flex w-full items-baseline gap-2 px-1 py-1 text-[12px]"
                >
                  <span className="shrink-0 font-mono text-[12px] text-kumo-subtle tabular-nums">
                    {clock(d.at)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{d.title}</span>
                  <span className="shrink-0 text-[12px] text-kumo-subtle">by {d.by}</span>
                </RefButton>
              </li>
            ))}
          </ul>
        </DetailBlock>
      )}
    </div>
  );
}
ResourceInspector.displayName = "ResourceInspector";

/* --------------------------------------------------------------------------------------------
 * Check
 * ------------------------------------------------------------------------------------------ */

export function CheckInspector({ entity }: { entity: EntityRef }) {
  const { state } = useFlight();
  const { candidateId, checkId } = parseCheckRef(entity.id);
  const candidate = state.candidates[candidateId];
  const gate = state.decisions.find((d) => d.id === `gate:${candidateId}`);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {candidate ? (
          <RefButton
            entity={{ kind: "candidate", id: candidateId }}
            mode="select"
            className="flex items-center gap-2 border border-kumo-rule px-2 py-0.5 text-[12px]"
          >
            <span className="font-semibold">{candidate.name}</span>
            <StatusPill status={candidate.status} />
          </RefButton>
        ) : (
          <Note>Candidate {candidateId} is not composed at the selected instant.</Note>
        )}
        {gate ? (
          <RefButton
            entity={{ kind: "decision", id: gate.id }}
            mode="select"
            className="border border-kumo-rule px-2 py-0.5 text-[12px]"
          >
            Gate decision: {gate.title}
          </RefButton>
        ) : (
          <span className="text-[12px] text-kumo-subtle">Gate decision not recorded yet.</span>
        )}
      </div>
      <CheckDetail candidateId={candidateId} checkId={checkId} />
    </div>
  );
}
CheckInspector.displayName = "CheckInspector";
