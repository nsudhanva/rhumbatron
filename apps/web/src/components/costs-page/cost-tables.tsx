import { Link } from "@tanstack/react-router";
import {
  EMPTY,
  formatAge,
  formatFraction,
  formatNumber,
  formatUsd,
  truncate,
} from "../../lib/format";
import { ChangeStatusPill } from "../project/status";
import { DataTable, Td, Th, TitleCell, TRow } from "../ui/data-table";
import { EmptyState } from "../ui/empty-state";
import { Mono } from "../ui/mono";
import { StatusPill } from "../ui/status-pill";
import {
  type ChangeCost,
  formatCost,
  type SelectedCost,
  TIER_LABEL,
  tierPath,
} from "./cost-format";

/**
 * Model usage by tier for one Change (AGENTS.md section 56): attempts, calls, the busiest
 * attempt against the per-run call cap, tokens and recorded cost.
 */
export function TierTable({ byTier }: { byTier: SelectedCost["byTier"] }) {
  return (
    <DataTable label="Model usage by tier" minWidth={560}>
      <thead>
        <tr>
          <Th>Tier</Th>
          <Th numeric>Attempts</Th>
          <Th numeric>Calls</Th>
          <Th numeric title="Most calls in one attempt / per-run cap">
            Peak / cap
          </Th>
          <Th numeric>Input</Th>
          <Th numeric>Output</Th>
          <Th numeric>Cost</Th>
        </tr>
      </thead>
      <tbody>
        {byTier.map((t) => {
          const atCap = t.runs > 0 && t.maxCallsInRun >= t.callCapPerRun;
          return (
            <TRow key={t.tier}>
              <Td>
                <TitleCell title={TIER_LABEL[t.tier]} meta={t.tier} />
              </Td>
              <Td numeric>{formatNumber(t.runs)}</Td>
              <Td numeric>{formatNumber(t.modelCalls)}</Td>
              <Td numeric className={atCap ? "font-semibold text-accent-700" : undefined}>
                {formatFraction(
                  t.runs > 0 ? formatNumber(t.maxCallsInRun) : EMPTY,
                  formatNumber(t.callCapPerRun),
                )}
              </Td>
              <Td numeric>{formatNumber(t.inputTokens)}</Td>
              <Td numeric>{formatNumber(t.outputTokens)}</Td>
              <Td numeric>{t.runs > 0 ? formatCost(t.costUsd) : EMPTY}</Td>
            </TRow>
          );
        })}
      </tbody>
    </DataTable>
  );
}
TierTable.displayName = "TierTable";

/** Model usage by Task, most tokens first; Tasks that never ran sit at the end with dashes. */
export function TaskTable({ byTask }: { byTask: SelectedCost["byTask"] }) {
  if (byTask.length === 0) {
    return (
      <EmptyState
        what="No Tasks yet."
        how="Tasks appear once the Change compiles into a Work Graph."
      />
    );
  }
  const rows = [...byTask].sort(
    (a, b) =>
      b.costUsd - a.costUsd ||
      b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
      a.key.localeCompare(b.key),
  );
  return (
    <DataTable label="Model usage by Task" minWidth={820}>
      <thead>
        <tr>
          <Th>Task</Th>
          <Th>Status</Th>
          <Th>Tiers</Th>
          <Th numeric>Attempts</Th>
          <Th numeric>Calls</Th>
          <Th numeric>Input</Th>
          <Th numeric>Output</Th>
          <Th numeric>Cost</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => {
          const ran = t.runs > 0;
          return (
            <TRow key={t.id}>
              <Td className="max-w-[320px]">
                <TitleCell title={t.title || t.key || t.id} meta={`${t.key} · ${t.kind}`} />
              </Td>
              <Td>
                <StatusPill status={t.status} />
              </Td>
              <Td>
                <Mono subtle={!ran}>{tierPath(t.tiers)}</Mono>
              </Td>
              <Td numeric>{formatNumber(t.runs)}</Td>
              <Td numeric>{ran ? formatNumber(t.modelCalls) : EMPTY}</Td>
              <Td numeric>{ran ? formatNumber(t.inputTokens) : EMPTY}</Td>
              <Td numeric>{ran ? formatNumber(t.outputTokens) : EMPTY}</Td>
              <Td numeric>{ran ? formatCost(t.costUsd) : EMPTY}</Td>
            </TRow>
          );
        })}
      </tbody>
    </DataTable>
  );
}
TaskTable.displayName = "TaskTable";

/**
 * The newest Changes with recorded spend against budget. A row selects that Change for the
 * detail sections (search param `change`); the whole row is the target.
 */
export function ChangeTable({
  projectId,
  changes,
  selectedId,
}: {
  projectId: string;
  changes: ChangeCost[];
  selectedId: string | undefined;
}) {
  return (
    <DataTable label="Changes by recorded spend" minWidth={760}>
      <thead>
        <tr>
          <Th>Change</Th>
          <Th>Status</Th>
          <Th numeric>Spend / budget</Th>
          <Th numeric>Calls</Th>
          <Th numeric>Tokens in / out</Th>
          <Th numeric>Age</Th>
        </tr>
      </thead>
      <tbody>
        {changes.map((c) => (
          <TRow key={c.id} selected={c.id === selectedId}>
            <Td className="max-w-[360px]">
              <TitleCell
                title={
                  <Link
                    to="/projects/$projectId/costs"
                    params={{ projectId }}
                    search={{ change: c.id }}
                    aria-current={c.id === selectedId ? "true" : undefined}
                    className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-[-2px] focus-visible:after:outline-accent-500"
                  >
                    {truncate(c.goal, 90)}
                  </Link>
                }
                meta={c.id}
              />
            </Td>
            <Td>
              <ChangeStatusPill status={c.status} />
            </Td>
            <Td
              numeric
              className={c.costUsd > c.budgetUsd ? "font-semibold text-accent-700" : undefined}
            >
              {formatFraction(formatCost(c.costUsd), formatUsd(c.budgetUsd))}
            </Td>
            <Td numeric>{formatNumber(c.modelCalls)}</Td>
            <Td numeric>
              {formatFraction(formatNumber(c.inputTokens), formatNumber(c.outputTokens))}
            </Td>
            <Td numeric>{formatAge(c.createdAt)}</Td>
          </TRow>
        ))}
      </tbody>
    </DataTable>
  );
}
ChangeTable.displayName = "ChangeTable";
