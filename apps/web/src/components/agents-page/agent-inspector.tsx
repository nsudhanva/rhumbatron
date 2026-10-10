import { ArrowRight } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { AgentClaim, AgentRunView, AgentView } from "../../lib/api";
import {
  EMPTY,
  formatAge,
  formatClock,
  formatDuration,
  formatNumber,
  formatUsd,
  timeAgo,
} from "../../lib/format";
import { CALLS_PER_RUN, describeStep } from "../agents/activity-model";
import { KeyValue } from "../ui/key-value";
import { ThresholdMeter } from "../ui/meter";
import { Mono } from "../ui/mono";
import { SectionLabel } from "../ui/page";
import { StatusPill } from "../ui/status-pill";
import { Tag } from "../ui/tag";
import { Term } from "../ui/term";
import { agentStatus, Details, modelName, plainRole } from "./agent-words";

/**
 * Detail of the selected agent (AGENTS.md 38.6): role, task and change, model, cost, what it is
 * doing now, its approach, its last activity and every attempt. Raw ids, tiers, locks and the
 * routing receipts sit under "Technical details". Receipts and failures are recorded outputs;
 * model reasoning is never stored, so it is never shown.
 */
export function AgentInspector({
  agent,
  feedAvailable,
}: {
  agent: AgentView;
  feedAvailable: boolean;
}) {
  const run = agent.runs.at(-1);
  const model = modelName(agent.tier, run?.provider);
  return (
    <aside
      aria-label={`${plainRole(agent.role)}: ${agent.task.title || agent.task.kind}`}
      className="grid min-w-0 content-start gap-5 rounded-lg border border-kumo-rule bg-kumo-elevated p-4"
    >
      <header className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[16px] font-semibold">{plainRole(agent.role)}</h3>
          <StatusPill status={agentStatus(agent)} />
        </div>
        <p className="text-[14px] text-pretty">{agent.task.title || agent.task.kind}</p>
      </header>

      <KeyValue
        items={[
          {
            label: "Change",
            value: (
              <Link
                to="/changes/$changeId"
                params={{ changeId: agent.task.changeId }}
                className="inline-flex items-center gap-1.5 text-kumo-accent hover:underline"
                title={agent.task.changeGoal}
              >
                <span className="line-clamp-2">{agent.task.changeGoal}</span>
                <ArrowRight size={14} aria-hidden className="shrink-0" />
              </Link>
            ),
          },
          { label: "Model", value: model ?? "Not chosen yet" },
          {
            label: "Attempts",
            value: (
              <span>
                {formatNumber(agent.attempts)}
                {agent.escalations > 0 && (
                  <>
                    {" · "}
                    <Term k="retriedStronger" />
                  </>
                )}
              </span>
            ),
          },
          { label: "Cost", value: formatUsd(agent.costUsd) },
          { label: "Last active", value: timeAgo(agent.lastActiveAt) },
        ]}
      />

      {run?.status === "running" && <LiveRun run={run} />}

      <div className="grid gap-2.5">
        <SectionLabel as="h4">
          <Term k="approach" />
        </SectionLabel>
        {agent.intent ? (
          <div className="grid gap-2">
            <p className="text-[14px] text-pretty">{agent.intent.summary}</p>
            {agent.intent.assumptions.length > 0 && (
              <ul className="grid gap-1 text-[13px] text-kumo-subtle">
                {agent.intent.assumptions.map((assumption) => (
                  <li key={assumption}>Assumes {assumption}</li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="text-[13px] text-kumo-subtle">
            No approach yet. The agent says what it will change when its first attempt finishes.
          </p>
        )}
      </div>

      <div className="grid gap-2.5">
        <SectionLabel as="h4">Last activity</SectionLabel>
        {agent.lastEvent ? (
          <p className="text-[13px] break-words">
            {agent.lastEvent.summary}{" "}
            <span className="text-kumo-subtle">· {formatAge(agent.lastEvent.occurredAt)}</span>
          </p>
        ) : (
          <p className="text-[13px] text-kumo-subtle">
            {feedAvailable
              ? "Nothing recent mentions this agent."
              : "Activity could not be read, so it is not shown."}
          </p>
        )}
      </div>

      <div className="grid gap-2.5">
        <SectionLabel as="h4" meta={<span>{formatNumber(agent.runs.length)}</span>}>
          Attempts
        </SectionLabel>
        {agent.runs.length === 0 ? (
          <p className="text-[13px] text-kumo-subtle">
            No attempt yet. The agent picks its model when it starts.
          </p>
        ) : (
          <ol className="grid">
            {[...agent.runs].reverse().map((r) => (
              <Attempt key={r.attempt} run={r} />
            ))}
          </ol>
        )}
      </div>

      <Details>
        <TechnicalDetails agent={agent} feedAvailable={feedAvailable} />
      </Details>
    </aside>
  );
}
AgentInspector.displayName = "AgentInspector";

/** What the running attempt is doing now, how long it has run, and its calls so far. */
function LiveRun({ run }: { run: AgentRunView }) {
  const cap = CALLS_PER_RUN[run.tier];
  return (
    <div className="grid gap-2 rounded-lg border border-kumo-rule bg-kumo-base p-3">
      <p className="text-[14px]">
        {run.lastStep ? describeStep(run.lastStep) : "Starting"}
        <span className="text-kumo-subtle"> · for {attemptDuration(run)}</span>
      </p>
      <ThresholdMeter
        label={`Model calls in attempt ${run.attempt}`}
        value={run.modelCalls}
        max={cap}
        valueText={`${run.modelCalls} of ${cap}`}
        size="inline"
      />
    </div>
  );
}
LiveRun.displayName = "LiveRun";

/** Wall time of one attempt; a running attempt counts up to now. */
function attemptDuration(run: AgentRunView, now = Date.now()) {
  const end = run.endedAt ? Date.parse(run.endedAt) : now;
  return formatDuration(Math.max(0, (end - Date.parse(run.startedAt)) / 1000));
}

function Attempt({ run }: { run: AgentRunView }) {
  return (
    <li className="grid gap-1 border-b border-kumo-rule py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="font-semibold">Attempt {run.attempt}</span>
          <span>{modelName(run.tier, run.provider)}</span>
          {run.escalatedFrom && <Tag variant="outline">Retried with a stronger model</Tag>}
        </p>
        <StatusPill status={run.status} />
      </div>
      <p className="text-[12px] text-kumo-subtle tabular-nums">
        {formatUsd(run.costUsd)} · {attemptDuration(run)} · started {formatClock(run.startedAt)}
        {" · "}
        <Term k="chosenAutomatically" plain />
      </p>
      {run.status === "failed" && (
        <p className="text-[13px] text-kumo-danger">
          Failed
          {run.failureReason
            ? `: ${run.failureReason}`
            : run.failureKind
              ? `: ${run.failureKind}`
              : ""}
        </p>
      )}
    </li>
  );
}
Attempt.displayName = "Attempt";

/** Raw ids, tiers, locks and routing receipts: the Advanced vocabulary, closed by default. */
function TechnicalDetails({ agent, feedAvailable }: { agent: AgentView; feedAvailable: boolean }) {
  return (
    <>
      <KeyValue
        items={[
          { label: "Agent", value: agent.agentId, mono: true },
          { label: "Role", value: agent.role },
          { label: "Task", value: `${agent.task.key} · ${agent.task.id}`, mono: true },
          {
            label: "Kind",
            value: [
              agent.task.kind,
              agent.task.complexity,
              agent.task.riskTier && `risk ${agent.task.riskTier}`,
            ]
              .filter(Boolean)
              .join(" · "),
          },
          { label: "Task status", value: agent.task.status, mono: true },
          { label: "Tier", value: agent.tier, mono: true },
          { label: "Model calls", value: formatNumber(agent.modelCalls), mono: true },
          {
            label: "Tokens",
            value: `${formatNumber(agent.inputTokens)} in · ${formatNumber(agent.outputTokens)} out`,
            mono: true,
          },
          {
            label: "Last event",
            value: agent.lastEvent
              ? `${agent.lastEvent.type} · ${formatClock(agent.lastEvent.occurredAt)}`
              : null,
            mono: true,
          },
        ]}
      />

      {agent.intent && agent.intent.semanticResources.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-kumo-subtle">Areas (semantic resources)</p>
          <div className="flex flex-wrap gap-1.5">
            {agent.intent.semanticResources.map((resource) => (
              <Tag key={resource} className="font-mono">
                {resource}
              </Tag>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-1.5">
        <p className="text-kumo-subtle">
          <Term k="lock">Locks</Term> (Claims)
        </p>
        <Locks claims={agent.claims} feedAvailable={feedAvailable} />
      </div>

      {agent.runs.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-kumo-subtle">Routing (Decision Receipts)</p>
          <ol className="grid gap-1.5">
            {agent.runs.map((r) => (
              <li key={r.attempt} className="grid gap-0.5">
                <span className="font-mono">
                  #{r.attempt} {r.escalatedFrom ? `${r.escalatedFrom} → ${r.tier}` : r.tier}
                  {r.provider ? ` · ${r.provider}` : ""} · decided by {r.decidedBy ?? EMPTY} ·{" "}
                  {formatNumber(r.modelCalls)} calls
                </span>
                <span className="text-kumo-subtle">
                  {r.reasons.length > 0 ? r.reasons.join(" · ") : "no reason recorded"}
                  {r.failureKind ? ` · failure ${r.failureKind}` : ""}
                </span>
              </li>
            ))}
          </ol>
          <p className="text-kumo-subtle">
            Receipts record routing inputs and outputs. Model reasoning is not recorded.
          </p>
        </div>
      )}
    </>
  );
}
TechnicalDetails.displayName = "TechnicalDetails";

const LOCK_STATUS = {
  active: { status: "active", label: "Held" },
  released: { status: "released", label: "Released", family: "idle" },
  expired: { status: "expired", label: "Expired", family: "attention" },
} as const;

function Locks({ claims, feedAvailable }: { claims: AgentClaim[] | null; feedAvailable: boolean }) {
  if (!claims || !feedAvailable) {
    return <p className="text-kumo-subtle">Not shown: the event feed is not readable.</p>;
  }
  if (claims.length === 0) {
    return <p className="text-kumo-subtle">None recorded.</p>;
  }
  return (
    <ul className="grid">
      {claims.map((claim) => {
        const view = LOCK_STATUS[claim.status];
        const lease =
          claim.status === "active" && claim.leaseExpiresAt
            ? `lease until ${formatClock(claim.leaseExpiresAt)}`
            : `updated ${timeAgo(claim.updatedAt)}`;
        return (
          <li
            key={claim.claimId}
            className="flex items-center justify-between gap-3 border-b border-kumo-rule py-1.5 last:border-b-0"
          >
            <span className="grid min-w-0">
              <Mono truncate>{claim.resource}</Mono>
              <span className="font-mono text-kumo-subtle">{lease}</span>
            </span>
            <StatusPill
              status={view.status}
              label={view.label}
              {...("family" in view ? { family: view.family } : {})}
            />
          </li>
        );
      })}
    </ul>
  );
}
Locks.displayName = "Locks";
