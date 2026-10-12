import { cn } from "@cloudflare/kumo";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { WorkspaceChangeSet } from "../../../lib/api";
import { formatClock, formatNumber, generation } from "../../../lib/format";
import { KeyValue } from "../../ui/key-value";
import { FAMILY_FILL, FAMILY_TEXT, StatusPill } from "../../ui/status-pill";
import { Tag } from "../../ui/tag";
import { DiffSummary } from "../../workspace-page/diff-summary";
import { AddsDels } from "../../workspace-page/fork-tree";
import { useFlight } from "../flight-context";
import type { CandidateState, ConflictState, FlightState } from "../flight-model";
import type { EntityRef } from "../flight-store";
import {
  checkView,
  composedChangeSets,
  gateGaps,
  gatePlayed,
  iso,
  isSettled,
  metricBits,
  standing,
} from "../panels/arena/check-view";
import { RefButton } from "../panels/arena/ref-button";

/**
 * Inspectors for Candidates, conflicts and ChangeSets (the inspector repeats the
 * selection's facts as text). Each reads the folded `state` at the time-machine instant; facts
 * not yet recorded at that instant are absent, and the inspector says so.
 */

function Block({
  label,
  meta,
  children,
}: {
  label: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid min-w-0 content-start gap-1.5">
      <div className="flex items-end justify-between gap-3 border-b-2 border-kumo-divider pb-1">
        <h3 className="type-h6">{label}</h3>
        {meta && <span className="text-[11px] text-kumo-subtle">{meta}</span>}
      </div>
      {children}
    </section>
  );
}
Block.displayName = "Block";

const short = (sha: string | null | undefined, n = 8) => (sha ? sha.slice(0, n) : null);

function Missing({ what }: { what: string }) {
  return <p className="text-[12px] text-kumo-subtle">{what}</p>;
}
Missing.displayName = "Missing";

/* --------------------------------------------------------------------------------------------
 * Candidate
 * ------------------------------------------------------------------------------------------ */

export function CandidateInspector({ entity }: { entity: EntityRef }) {
  const { state, model, changeId } = useFlight();
  const candidate = state.candidates[entity.id];
  if (!candidate) {
    return (
      <Missing what="This Candidate was not composed yet at the selected instant. Move the time machine forward or go live." />
    );
  }
  const settled = isSettled(candidate);
  const line = standing(state, candidate);
  const approval = candidate.approval;
  const composed = composedChangeSets(state, model, candidate);
  const gaps = gateGaps(state, candidate);
  const plan = candidate.detail.plan;
  const decisions = state.decisions.filter(
    (d) => d.subject.kind === "candidate" && d.subject.id === candidate.id,
  );
  const tasks = [...new Set(candidate.taskIds)].map((id) => state.tasks[id]).filter((t) => !!t);

  return (
    <div className="grid min-w-0 gap-4 text-[12px]">
      <div className="grid gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={cn(
              "grid size-6 shrink-0 place-items-center text-[12px] font-extrabold text-kumo-inverse",
              candidate.status === "promoted" || candidate.status === "verified"
                ? "bg-accent-500"
                : "bg-kumo-ink",
            )}
          >
            {candidate.letter}
          </span>
          <span className="min-w-0 truncate text-[15px] font-extrabold">{candidate.name}</span>
          <StatusPill status={candidate.status} className="ml-auto" />
        </div>
        {line && (
          <p
            className={cn(
              "text-[12px]",
              candidate.status === "rejected" ? "text-kumo-danger" : "text-kumo-default",
            )}
          >
            {line}
          </p>
        )}
        <KeyValue
          items={[
            { label: "Id", value: candidate.id, mono: true },
            {
              label: "Generation",
              value:
                candidate.promotedGeneration !== null
                  ? `${generation(candidate.detail.baseGeneration)} → ${generation(candidate.promotedGeneration)}`
                  : `base ${generation(candidate.detail.baseGeneration)}`,
              mono: true,
            },
            { label: "Forked", value: formatClock(iso(candidate.forkedAt)), mono: true },
            {
              label: "Composed commit",
              value: short(candidate.detail.composedCommit, 12),
              mono: true,
            },
            {
              label: "Approval",
              value: approval
                ? `${approval.decision === "granted" ? "Granted" : "Rejected"} by ${approval.approverUserId} at ${formatClock(approval.createdAt)}${approval.reason ? ` · ${approval.reason}` : ""}`
                : candidate.detail.approvalRequired
                  ? "Required, not decided at this instant"
                  : "Not required by policy",
            },
          ]}
        />
      </div>

      <Block label="ChangeSets" meta={`${formatNumber(composed.length)} composed`}>
        {composed.length === 0 ? (
          <Missing what="Canonical baseline: no ChangeSets composed." />
        ) : (
          <ul className="grid">
            {composed.map((cs) => (
              <li key={cs.id} className="border-b border-kumo-rule">
                <RefButton
                  mode="select"
                  entity={{ kind: "changeset", id: cs.id }}
                  className="grid w-full grid-cols-[48px_minmax(0,1fr)_auto] items-baseline gap-2 px-1 py-1"
                >
                  <span className="font-mono text-[11px] font-semibold">{cs.taskKey}</span>
                  <span className="truncate font-mono text-[11px] text-kumo-subtle">
                    {short(cs.record?.commit) ?? cs.id}
                    {cs.record
                      ? ` · ${formatNumber(cs.record.files.length)} files`
                      : " · not recorded"}
                  </span>
                  {cs.record ? (
                    <AddsDels
                      adds={cs.record.insertions}
                      dels={cs.record.deletions}
                      className="font-mono text-[11px]"
                    />
                  ) : (
                    <span />
                  )}
                </RefButton>
              </li>
            ))}
          </ul>
        )}
      </Block>

      {tasks.length > 0 && (
        <Block label="Tasks">
          <ul className="grid">
            {tasks.map((t) => (
              <li key={t.id} className="border-b border-kumo-rule">
                <RefButton
                  mode="select"
                  entity={{ kind: "task", id: t.id }}
                  className="flex w-full items-baseline gap-2 px-1 py-1"
                >
                  <span className="font-mono text-[11px] font-semibold">{t.key}</span>
                  <span className="min-w-0 truncate">{t.title}</span>
                  <StatusPill status={t.status} className="ml-auto" />
                </RefButton>
              </li>
            ))}
          </ul>
        </Block>
      )}

      <Block
        label="Checks"
        meta={`${candidate.checks.filter((c) => c.record).length} / ${candidate.checks.length} with evidence`}
      >
        {candidate.checks.length === 0 ? (
          <Missing what="Verification plan not built yet." />
        ) : (
          <ul className="grid">
            {candidate.checks.map((check) => {
              const view = checkView(check, settled);
              const bits = metricBits(state, candidate, check);
              return (
                <li key={check.checkId} className="border-b border-kumo-rule">
                  <RefButton
                    mode="select"
                    entity={{ kind: "check", id: `${candidate.id}:${check.checkId}` }}
                    className="grid w-full gap-0.5 px-1 py-1"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden
                        className={cn(
                          "size-2.5 shrink-0",
                          view.hollow ? "border-2 border-kumo-warning" : FAMILY_FILL[view.family],
                        )}
                      />
                      <span className="font-mono text-[11px]">{check.checkId}</span>
                      <span className={cn("font-semibold", FAMILY_TEXT[view.family])}>
                        {view.word}
                      </span>
                      <span className="truncate text-[11px] text-kumo-subtle">{view.coverage}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-kumo-subtle">
                        {check.required ? "required" : "optional"}
                      </span>
                    </span>
                    {bits.length > 0 && (
                      <span className="truncate pl-4.5 font-mono text-[11px] text-kumo-subtle">
                        {bits.join(" · ")}
                      </span>
                    )}
                  </RefButton>
                </li>
              );
            })}
          </ul>
        )}
      </Block>

      <Block label="Gate">
        {!gatePlayed(state, candidate.id) ? (
          <Missing what="No verification verdict at this instant." />
        ) : gaps.length === 0 ? (
          <p className="text-kumo-success">
            Promotable: every required check has a supported pass.
          </p>
        ) : (
          <ul className="grid gap-0.5">
            {gaps.map((g) => (
              <li key={g.checkId}>
                <span className="font-mono text-[11px]">{g.checkId}</span>
                <span className="text-kumo-subtle"> · {g.words}</span>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block label="Verification plan">
        {plan ? (
          <KeyValue
            items={[
              { label: "Required", value: plan.requiredCheckIds.join(", "), mono: true },
              {
                label: "Human approval",
                value: plan.humanApprovalRequired ? "Required" : "Not required",
              },
              { label: "Policy", value: plan.policyVersion, mono: true },
            ]}
          />
        ) : (
          <Missing what="No plan recorded." />
        )}
      </Block>

      {decisions.length > 0 && (
        <Block label="Decisions">
          <ul className="grid">
            {decisions.map((d) => (
              <li key={d.id} className="border-b border-kumo-rule">
                <RefButton
                  mode="select"
                  entity={{ kind: "decision", id: d.id }}
                  className="grid w-full gap-0.5 px-1 py-1"
                >
                  <span className="flex items-baseline gap-2">
                    <Tag>{d.kind}</Tag>
                    <span className="min-w-0 truncate font-semibold">{d.title}</span>
                  </span>
                  <span className="line-clamp-2 text-[11px] text-kumo-subtle">
                    {d.verdict} · by {d.by}
                  </span>
                </RefButton>
              </li>
            ))}
          </ul>
        </Block>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-kumo-rule pt-2 text-[12px]">
        <Link
          to="/candidates/$candidateId"
          params={{ candidateId: candidate.id }}
          className="text-kumo-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
        >
          Open Candidate page
        </Link>
        <Link
          to="/compare/$changeId"
          params={{ changeId }}
          className="text-kumo-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
        >
          Compare Candidates
        </Link>
      </div>
    </div>
  );
}
CandidateInspector.displayName = "CandidateInspector";

/* --------------------------------------------------------------------------------------------
 * Conflict
 * ------------------------------------------------------------------------------------------ */

function List({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="grid gap-0.5">
      <span className="type-label text-kumo-subtle">{label}</span>
      {items.length === 0 ? (
        <span className="text-[11px] text-kumo-subtle">none declared</span>
      ) : (
        <ul className="grid gap-0.5">
          {items.map((item) => (
            <li key={item} className="text-[11px] break-words">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
List.displayName = "List";

function Side({
  state,
  conflict,
  index,
}: {
  state: FlightState;
  conflict: ConflictState;
  index: 0 | 1;
}) {
  const intent = conflict.detail.intents[index];
  const taskId = conflict.taskIds[index];
  const task = state.tasks[taskId];
  const declared = task?.intent;
  const candidateId = conflict.candidateIds[index];
  const candidate = candidateId ? state.candidates[candidateId] : undefined;
  const other = state.tasks[conflict.taskIds[index === 0 ? 1 : 0]];
  const otherPaths = new Set(other?.files.changed.map((f) => f.path) ?? []);
  const changeSets: WorkspaceChangeSet[] = task?.changeSets ?? [];
  return (
    <div className="grid min-w-0 content-start gap-2 border-t-2 border-kumo-divider pt-1.5">
      <span className="type-label text-kumo-subtle">
        {index === 0 ? "Side A · challenger" : "Side B"}
      </span>
      <p className="text-[12px] font-semibold">{intent.summary || "No summary recorded."}</p>
      <RefButton
        mode="select"
        entity={{ kind: "task", id: taskId }}
        className="flex w-full items-baseline gap-1.5 px-1 py-0.5"
      >
        <span className="font-mono text-[11px] font-semibold">{intent.taskKey}</span>
        <span className="min-w-0 truncate text-[11px] text-kumo-subtle">{intent.agentId}</span>
      </RefButton>
      <List label="Expected files" items={declared?.expectedFiles ?? []} />
      <List label="Contract changes" items={declared?.expectedContractChanges ?? []} />
      <List label="Data changes" items={declared?.expectedDataChanges ?? []} />
      <List label="Assumptions" items={intent.assumptions} />
      <div className="grid gap-0.5">
        <span className="type-label text-kumo-subtle">ChangeSets</span>
        {changeSets.length === 0 ? (
          <span className="text-[11px] text-kumo-subtle">none published at this instant</span>
        ) : (
          changeSets.map((cs) => (
            <div key={cs.id} className="grid gap-0.5">
              <RefButton
                mode="select"
                entity={{ kind: "changeset", id: cs.id }}
                className="flex w-full items-baseline gap-1.5 px-1 py-0.5"
              >
                <span className="font-mono text-[11px]">{short(cs.commit)}</span>
                <AddsDels
                  adds={cs.insertions}
                  dels={cs.deletions}
                  className="ml-auto font-mono text-[11px]"
                />
              </RefButton>
              <ul className="grid">
                {(cs.fileStats.length > 0
                  ? cs.fileStats
                  : cs.files.map((path) => ({ path, adds: null, dels: null }))
                ).map((f) => (
                  <li key={f.path} className="flex min-w-0 items-baseline gap-1.5 text-[11px]">
                    <span className="min-w-0 truncate font-mono" title={f.path}>
                      {f.path}
                    </span>
                    {otherPaths.has(f.path) && (
                      <span className="shrink-0 font-semibold text-kumo-warning">contended</span>
                    )}
                    <AddsDels adds={f.adds} dels={f.dels} className="ml-auto font-mono" />
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
      <div className="grid gap-0.5">
        <span className="type-label text-kumo-subtle">Candidate</span>
        {candidate ? (
          <RefButton
            mode="select"
            entity={{ kind: "candidate", id: candidate.id }}
            className="flex w-full items-center gap-2 px-1 py-0.5"
          >
            <span className="font-semibold">{candidate.name}</span>
            <StatusPill status={candidate.status} className="ml-auto" />
          </RefButton>
        ) : (
          <span className="text-[11px] text-kumo-subtle">no Candidate at this instant</span>
        )}
      </div>
    </div>
  );
}
Side.displayName = "Side";

const SEVERITY_STATUS: Record<string, { status: string; family: "danger" | "attention" | "idle" }> =
  {
    hard: { status: "hard", family: "danger" },
    soft: { status: "soft", family: "attention" },
    benign: { status: "benign", family: "idle" },
  };

export function ConflictInspector({ entity }: { entity: EntityRef }) {
  const { state } = useFlight();
  const conflict = state.conflicts.find((c) => c.id === entity.id);
  if (!conflict) {
    return (
      <Missing what="This conflict was not detected yet at the selected instant. Move the time machine forward or go live." />
    );
  }
  const d = conflict.detail;
  const fd = d.forkDecision;
  const forkDecision = state.decisions.find((x) => x.id === `fork:${conflict.id}`);
  return (
    <div className="grid min-w-0 gap-4 text-[12px]">
      <div className="grid gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-extrabold text-kumo-accent">Conflict</span>
          <StatusPill status={conflict.state} className="ml-auto" />
        </div>
        <KeyValue
          items={[
            { label: "Resource", value: conflict.resource, mono: true },
            { label: "Status", value: conflict.open ? "Open" : "Resolved" },
            {
              label: "Challenge",
              value: conflict.challenged
                ? `Sent${d.challengeId ? ` · ${d.challengeId}` : ""}`
                : "None: the detector only suspects a conflict",
            },
            { label: "Recommended", value: d.recommendedAction.replace(/_/g, " ") },
          ]}
        />
      </div>

      <Block label="Competing Intents">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
          <Side state={state} conflict={conflict} index={0} />
          <Side state={state} conflict={conflict} index={1} />
        </div>
      </Block>

      <Block label="Signals" meta={`${d.signals.length}`}>
        {d.signals.length === 0 ? (
          <Missing what="No signals recorded." />
        ) : (
          <ul className="grid">
            {d.signals.map((s, i) => {
              const sev = SEVERITY_STATUS[s.severity] ?? { status: s.severity, family: "idle" };
              return (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: signals have no id
                  key={i}
                  className="grid gap-0.5 border-b border-kumo-rule py-1"
                >
                  <span className="flex items-center gap-2">
                    <StatusPill status={sev.status} family={sev.family} />
                    <span className="font-semibold">{s.kind.replace(/_/g, " ")}</span>
                  </span>
                  <span className="text-kumo-subtle">{s.detail}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Block>

      <Block label="Review and fork decision">
        <KeyValue
          items={[
            { label: "Reviewed by", value: d.review.decidedBy },
            { label: "Rationale", value: d.review.rationale ?? "not recorded" },
            {
              label: "Decision",
              value:
                fd.kind === "fork"
                  ? `Fork Candidates · ${fd.reason}`
                  : fd.kind === "blocked"
                    ? `Fork blocked · Candidate limit of ${fd.maxCandidates} reached`
                    : `No fork · ${fd.reason.replace(/_/g, " ")}`,
            },
          ]}
        />
        {forkDecision && (
          <RefButton
            mode="select"
            entity={{ kind: "decision", id: forkDecision.id }}
            className="flex w-full items-baseline gap-2 px-1 py-1"
          >
            <Tag>fork</Tag>
            <span className="min-w-0 truncate">{forkDecision.title}</span>
          </RefButton>
        )}
      </Block>
    </div>
  );
}
ConflictInspector.displayName = "ConflictInspector";

/* --------------------------------------------------------------------------------------------
 * ChangeSet
 * ------------------------------------------------------------------------------------------ */

export function ChangeSetInspector({ entity }: { entity: EntityRef }) {
  const { state, model } = useFlight();
  const task = Object.values(state.tasks).find((t) =>
    t.changeSets.some((cs) => cs.id === entity.id),
  );
  const changeSet = task?.changeSets.find((cs) => cs.id === entity.id);
  if (!task || !changeSet) {
    return (
      <Missing
        what={
          model.changeSets[entity.id]
            ? "This ChangeSet was not published yet at the selected instant. Move the time machine forward or go live."
            : "This ChangeSet is not in the Workspace view, so its commit and files are not recorded here."
        }
      />
    );
  }
  const candidates = state.candidateOrder
    .map((id) => state.candidates[id])
    .filter((c): c is CandidateState => !!c && c.changeSetIds.includes(changeSet.id));
  return (
    <div className="grid min-w-0 gap-4 text-[12px]">
      <KeyValue
        items={[
          { label: "Id", value: changeSet.id, mono: true },
          { label: "Status", value: <StatusPill status={changeSet.status} /> },
          { label: "Commit", value: changeSet.commit, mono: true },
          { label: "Base commit", value: changeSet.baseCommit, mono: true },
          { label: "Fork", value: changeSet.fork, mono: true },
          { label: "Created", value: formatClock(changeSet.createdAt), mono: true },
          {
            label: "Lines",
            value: (
              <AddsDels
                adds={changeSet.insertions}
                dels={changeSet.deletions}
                className="font-mono"
              />
            ),
          },
        ]}
      />
      <Block label="Task">
        <RefButton
          mode="select"
          entity={{ kind: "task", id: task.id }}
          className="flex w-full items-baseline gap-2 px-1 py-1"
        >
          <span className="font-mono text-[11px] font-semibold">{task.key}</span>
          <span className="min-w-0 truncate">{task.title}</span>
          <StatusPill status={task.status} className="ml-auto" />
        </RefButton>
      </Block>
      <Block label="Files" meta={`${formatNumber(changeSet.files.length)} changed`}>
        <DiffSummary changeSet={changeSet} />
      </Block>
      <Block label="Composed into">
        {candidates.length === 0 ? (
          <Missing what="No Candidate composed this ChangeSet at this instant." />
        ) : (
          <ul className="grid">
            {candidates.map((c) => (
              <li key={c.id} className="border-b border-kumo-rule">
                <RefButton
                  mode="select"
                  entity={{ kind: "candidate", id: c.id }}
                  className="flex w-full items-center gap-2 px-1 py-1"
                >
                  <span className="font-semibold">{c.name}</span>
                  <span className="font-mono text-[11px] text-kumo-subtle">{c.id}</span>
                  <StatusPill status={c.status} className="ml-auto" />
                </RefButton>
              </li>
            ))}
          </ul>
        )}
      </Block>
    </div>
  );
}
ChangeSetInspector.displayName = "ChangeSetInspector";
