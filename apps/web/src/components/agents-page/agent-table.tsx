import { cn } from "@cloudflare/kumo";
import type { AgentView } from "../../lib/api";
import { EMPTY, formatAge, formatNumber, formatUsd, truncate } from "../../lib/format";
import { CALLS_PER_RUN } from "../agents/activity-model";
import { DataTable, Td, Th, TitleCell, TRow } from "../ui/data-table";
import { Mono } from "../ui/mono";
import { StatusPill } from "../ui/status-pill";

/**
 * Agents as table rows (DESIGN.md 8.3). The whole row selects the agent for the inspector beside
 * the table; the row carries no other link, so the Change link lives in the inspector.
 *
 * `active` rows show the current attempt: tier, calls against the per-run cap with a 4px ink bar
 * that advances with each recorded model call, and the age of the last progress write.
 * `recent` rows show totals over every attempt and the Task result.
 */
export function AgentTable({
  agents,
  variant,
  selectedId,
  onSelect,
  label,
}: {
  agents: AgentView[];
  variant: "active" | "recent";
  selectedId: string | null;
  onSelect: (agentId: string) => void;
  label: string;
}) {
  return (
    <DataTable minWidth={760} label={label}>
      <thead>
        <tr>
          <Th>Agent</Th>
          <Th>Task</Th>
          <Th>Model</Th>
          <Th numeric>{variant === "active" ? "Calls this run" : "Model calls"}</Th>
          <Th numeric>Cost</Th>
          <Th numeric>{variant === "active" ? "Updated" : "Last active"}</Th>
          <Th>{variant === "active" ? "State" : "Result"}</Th>
        </tr>
      </thead>
      <tbody>
        {agents.map((agent) => (
          <AgentRow
            key={agent.agentId}
            agent={agent}
            variant={variant}
            selected={agent.agentId === selectedId}
            onSelect={onSelect}
          />
        ))}
      </tbody>
    </DataTable>
  );
}
AgentTable.displayName = "AgentTable";

function AgentRow({
  agent,
  variant,
  selected,
  onSelect,
}: {
  agent: AgentView;
  variant: "active" | "recent";
  selected: boolean;
  onSelect: (agentId: string) => void;
}) {
  const run = agent.runs.at(-1);
  const updated =
    variant === "active" ? (run?.progressAt ?? run?.startedAt ?? agent.lastActiveAt) : null;
  return (
    <TRow selected={selected} className="cursor-pointer">
      <Td className="max-w-56">
        <TitleCell
          title={
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(agent.agentId)}
              className="text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-[-2px] focus-visible:after:outline-accent-500"
            >
              {agent.role}
            </button>
          }
          meta={agent.agentId}
        />
      </Td>
      <Td className="max-w-80">
        <TitleCell
          title={
            <span title={agent.task.title}>
              <Mono className="font-normal">{agent.task.key}</Mono> {agent.task.title}
            </span>
          }
          meta={<span title={agent.task.changeGoal}>{truncate(agent.task.changeGoal, 64)}</span>}
        />
      </Td>
      <Td>
        <div className="grid">
          <Mono>{agent.tier}</Mono>
          <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
            {agent.attempts === 0
              ? "no attempt yet"
              : `attempt ${agent.attempts}${agent.escalations > 0 ? " · escalated" : ""}`}
          </span>
        </div>
      </Td>
      <Td numeric>
        {variant === "active" ? <RunCalls agent={agent} /> : formatNumber(agent.modelCalls)}
      </Td>
      <Td numeric>{formatUsd(agent.costUsd)}</Td>
      <Td numeric className="text-kumo-subtle">
        {formatAge(updated ?? agent.lastActiveAt)}
      </Td>
      <Td>
        <StatusPill status={agent.task.status} />
      </Td>
    </TRow>
  );
}
AgentRow.displayName = "AgentRow";

/** Model calls of the running attempt against its per-run cap, as text plus a 4px bar. */
function RunCalls({ agent, className }: { agent: AgentView; className?: string }) {
  const run = agent.runs.at(-1);
  if (run?.status !== "running") {
    return <span className="text-kumo-subtle">{run ? EMPTY : "waking"}</span>;
  }
  const cap = CALLS_PER_RUN[run.tier];
  const pct = Math.min(100, (run.modelCalls / cap) * 100);
  return (
    <span className={cn("inline-flex w-full max-w-36 items-center justify-end gap-2", className)}>
      <span aria-hidden className="h-1 min-w-10 grow bg-kumo-recessed">
        <span
          className="block h-full bg-kumo-ink transition-[width] duration-(--rh-dur-bar)"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span>
        {run.modelCalls} / {cap}
      </span>
    </span>
  );
}
RunCalls.displayName = "RunCalls";
