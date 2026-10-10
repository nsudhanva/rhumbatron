import type { AgentView } from "../../lib/api";
import { formatAge, formatUsd, truncate } from "../../lib/format";
import { describeStep } from "../agents/activity-model";
import { DataTable, Td, Th, TitleCell, TRow } from "../ui/data-table";
import { StatusPill } from "../ui/status-pill";
import { agentStatus, modelName, plainRole } from "./agent-words";

/**
 * Agents as table rows (DESIGN.md 8.3). The whole row selects the agent for the inspector beside
 * the table; the row carries no other link, so the Change link lives in the inspector.
 *
 * Plain words only (spec 7.6): role, what the agent is doing now as a sentence, the model by
 * product name, one status. Ids, tiers and call counts are in the inspector's Technical details.
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
    <DataTable minWidth={680} label={label}>
      <thead>
        <tr>
          <Th>Agent</Th>
          <Th>Task</Th>
          <Th>Model</Th>
          <Th numeric>Cost</Th>
          <Th numeric>{variant === "active" ? "Updated" : "Last active"}</Th>
          <Th>Status</Th>
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

/** What a working agent is doing now, as one sentence (spec 6.2 P7). */
function doingNow(agent: AgentView): string | null {
  const run = agent.runs.at(-1);
  if (agent.state !== "active" || run?.status !== "running") return null;
  return run.lastStep ? describeStep(run.lastStep) : "Starting";
}

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
  const doing = doingNow(agent);
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
              {plainRole(agent.role)}
            </button>
          }
          meta={doing ? <span title={run?.lastStep ?? undefined}>{doing}</span> : undefined}
        />
      </Td>
      <Td className="max-w-80">
        <TitleCell
          title={<span title={agent.task.title}>{agent.task.title || agent.task.kind}</span>}
          meta={<span title={agent.task.changeGoal}>{truncate(agent.task.changeGoal, 64)}</span>}
        />
      </Td>
      <Td>
        <TitleCell
          title={
            <span className="font-normal">
              {modelName(agent.tier, run?.provider) ?? "Not chosen yet"}
            </span>
          }
          meta={
            agent.escalations > 0
              ? "Retried with a stronger model"
              : agent.attempts > 1
                ? `Attempt ${agent.attempts}`
                : undefined
          }
        />
      </Td>
      <Td numeric>{formatUsd(agent.costUsd)}</Td>
      <Td numeric className="text-kumo-subtle">
        {formatAge(updated ?? agent.lastActiveAt)}
      </Td>
      <Td>
        <StatusPill status={agentStatus(agent)} />
      </Td>
    </TRow>
  );
}
AgentRow.displayName = "AgentRow";
