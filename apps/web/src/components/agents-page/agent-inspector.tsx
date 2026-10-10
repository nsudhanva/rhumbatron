import { cn } from "@cloudflare/kumo";
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
import { CALLS_PER_RUN } from "../agents/activity-model";
import { KeyValue } from "../ui/key-value";
import { ThresholdMeter } from "../ui/meter";
import { Mono } from "../ui/mono";
import { SectionLabel } from "../ui/page";
import { StatusPill } from "../ui/status-pill";
import { Tag } from "../ui/tag";

/**
 * Detail of the selected agent (DESIGN.md 6.3, 8.3 layer card, AGENTS.md 38.6): role, Task and
 * Change, model, cost, live progress of the running attempt, current Intent, Claims, the last
 * important event, and every attempt with its Decision Receipt. Receipts and failures are
 * recorded outputs; model reasoning is never stored, so it is never shown.
 */
export function AgentInspector({
  agent,
  feedAvailable,
}: {
  agent: AgentView;
  feedAvailable: boolean;
}) {
  const run = agent.runs.at(-1);
  return (
    <aside
      aria-label={`Agent ${agent.agentId}`}
      className="grid min-w-0 content-start gap-5 bg-kumo-elevated p-4"
    >
      <header className="grid gap-1.5">
        <p className="type-kicker text-kumo-accent">{agent.role}</p>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 truncate font-mono text-[15px] font-semibold">{agent.agentId}</h3>
          <StatusPill status={agent.state === "active" ? agent.task.status : "asleep"} />
        </div>
        <p className="text-[13px]">
          <Mono>{agent.task.key}</Mono> {agent.task.title || agent.task.kind}
        </p>
      </header>

      <KeyValue
        items={[
          { label: "Task", value: agent.task.id, mono: true },
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
          { label: "Task status", value: <StatusPill status={agent.task.status} /> },
          { label: "Model", value: agent.tier, mono: true },
          {
            label: "Attempts",
            value: `${agent.attempts}${agent.escalations ? ` · ${agent.escalations} escalated` : ""}`,
            mono: true,
          },
          { label: "Model calls", value: formatNumber(agent.modelCalls), mono: true },
          {
            label: "Tokens",
            value: `${formatNumber(agent.inputTokens)} in · ${formatNumber(agent.outputTokens)} out`,
            mono: true,
          },
          { label: "Cost", value: formatUsd(agent.costUsd), mono: true },
          { label: "Last active", value: timeAgo(agent.lastActiveAt), mono: true },
        ]}
      />

      {run?.status === "running" && <LiveRun run={run} />}

      <div className="grid gap-2.5">
        <SectionLabel as="h4">Current Intent</SectionLabel>
        {agent.intent ? (
          <div className="grid gap-2">
            <p className="text-[13px] text-pretty">{agent.intent.summary}</p>
            {agent.intent.semanticResources.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {agent.intent.semanticResources.map((resource) => (
                  <Tag key={resource} className="font-mono">
                    {resource}
                  </Tag>
                ))}
              </div>
            )}
            {agent.intent.assumptions.length > 0 && (
              <ul className="grid gap-1 text-[12px] text-kumo-subtle">
                {agent.intent.assumptions.map((assumption) => (
                  <li key={assumption}>Assumes {assumption}</li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="text-[13px] text-kumo-subtle">
            No Intent yet. The agent declares its typed Intent when an attempt completes.
          </p>
        )}
      </div>

      <div className="grid gap-2.5">
        <SectionLabel
          as="h4"
          meta={agent.claims ? <Mono subtle>{agent.claims.length}</Mono> : undefined}
        >
          Claims
        </SectionLabel>
        <Claims claims={agent.claims} feedAvailable={feedAvailable} />
      </div>

      <div className="grid gap-2.5">
        <SectionLabel as="h4">Last event</SectionLabel>
        {agent.lastEvent ? (
          <div className="grid gap-1">
            <p className="flex flex-wrap items-baseline gap-x-2 font-mono text-[12px]">
              <span className="font-semibold">{agent.lastEvent.type}</span>
              <span className="text-kumo-subtle">
                {formatClock(agent.lastEvent.occurredAt)} · {formatAge(agent.lastEvent.occurredAt)}
              </span>
            </p>
            <p className="text-[13px] break-words">{agent.lastEvent.summary}</p>
          </div>
        ) : (
          <p className="text-[13px] text-kumo-subtle">
            {feedAvailable
              ? "No recent event names this agent."
              : "The event feed is not readable, so events are not shown."}
          </p>
        )}
      </div>

      <div className="grid gap-2.5">
        <SectionLabel as="h4" meta={<Mono subtle>{agent.runs.length}</Mono>}>
          Attempts and routing
        </SectionLabel>
        {agent.runs.length === 0 ? (
          <p className="text-[13px] text-kumo-subtle">
            No attempt yet. The agent is assigned and routes its first model call next.
          </p>
        ) : (
          <ol className="grid">
            {[...agent.runs].reverse().map((r) => (
              <Attempt key={r.attempt} run={r} />
            ))}
          </ol>
        )}
        <p className="text-[11px] text-kumo-subtle">
          Decision Receipts record routing inputs and outputs. Model reasoning is not recorded.
        </p>
      </div>
    </aside>
  );
}
AgentInspector.displayName = "AgentInspector";

/** Progress of the running attempt: calls against the per-run cap and the last tool step. */
function LiveRun({ run }: { run: AgentRunView }) {
  const cap = CALLS_PER_RUN[run.tier];
  return (
    <div className="grid gap-2 bg-kumo-base p-3">
      <ThresholdMeter
        label={`Model calls · attempt ${run.attempt} on ${run.tier}`}
        value={run.modelCalls}
        max={cap}
        valueText={`${run.modelCalls} / ${cap}`}
        size="inline"
      />
      <KeyValue
        items={[
          { label: "Last step", value: run.lastStep, mono: true },
          {
            label: "Progress",
            value: run.progressAt ? timeAgo(run.progressAt) : null,
            mono: true,
          },
          { label: "Running for", value: attemptDuration(run), mono: true },
        ]}
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

const CLAIM_STATUS = {
  active: { status: "active", label: "Held" },
  released: { status: "released", label: "Released", family: "idle" },
  expired: { status: "expired", label: "Expired", family: "attention" },
} as const;

function Claims({
  claims,
  feedAvailable,
}: {
  claims: AgentClaim[] | null;
  feedAvailable: boolean;
}) {
  if (!claims || !feedAvailable) {
    return (
      <p className="text-[13px] text-kumo-subtle">
        Claims are not shown: the event feed is not readable.
      </p>
    );
  }
  if (claims.length === 0) {
    return (
      <p className="text-[13px] text-kumo-subtle">
        No Claims recorded. An agent claims a semantic resource before it writes to it.
      </p>
    );
  }
  return (
    <ul className="grid">
      {claims.map((claim) => {
        const view = CLAIM_STATUS[claim.status];
        const lease =
          claim.status === "active" && claim.leaseExpiresAt
            ? `lease until ${formatClock(claim.leaseExpiresAt)}`
            : `updated ${timeAgo(claim.updatedAt)}`;
        return (
          <li
            key={claim.claimId}
            className="flex items-center justify-between gap-3 border-b border-kumo-rule py-2 last:border-b-0"
          >
            <span className="grid min-w-0">
              <Mono truncate>{claim.resource}</Mono>
              <span className="font-mono text-[11px] text-kumo-subtle">{lease}</span>
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
Claims.displayName = "Claims";

function Attempt({ run }: { run: AgentRunView }) {
  return (
    <li className="grid gap-1.5 border-b border-kumo-rule py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-center gap-2 font-mono text-[12px]">
          <span className="font-semibold">#{run.attempt}</span>
          <span>{run.escalatedFrom ? `${run.escalatedFrom} → ${run.tier}` : run.tier}</span>
          {run.escalatedFrom && <Tag variant="outline">Escalated</Tag>}
          {/* Attempts before ADR 0021 that ran on Gemini (Vertex AI, ADR 0016). */}
          {run.provider === "google-vertex-ai" && <Tag variant="outline">Gemini</Tag>}
        </p>
        <StatusPill status={run.status} />
      </div>
      <p className="font-mono text-[11px] text-kumo-subtle tabular-nums">
        {formatNumber(run.modelCalls)} calls · {formatUsd(run.costUsd)} · {attemptDuration(run)} ·
        started {formatClock(run.startedAt)}
      </p>
      <p className={cn("text-[12px]", run.reasons.length === 0 && "text-kumo-subtle")}>
        <span className="text-kumo-subtle">Routed by {run.decidedBy ?? EMPTY}: </span>
        {run.reasons.length > 0 ? run.reasons.join(" · ") : "no reason recorded"}
      </p>
      {run.status === "failed" && (
        <p className="text-[12px] text-kumo-danger">
          <span className="font-semibold">FAIL</span>
          {run.failureKind && <span className="font-mono"> {run.failureKind}</span>}
          {run.failureReason && <span>. {run.failureReason}</span>}
        </p>
      )}
    </li>
  );
}
Attempt.displayName = "Attempt";
