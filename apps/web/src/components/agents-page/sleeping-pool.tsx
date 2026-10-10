import { formatNumber } from "../../lib/format";
import { Term } from "../ui/term";
import { Details, plainRole } from "./agent-words";

/**
 * Idle agents as one sentence (spec B.2: "12 agents idle"), with the split by plain role behind
 * a disclosure. Idle is a resting state, not one that needs attention, so nothing here is colored.
 */
export function SleepingPool({
  total,
  unlisted,
  notWoken,
}: {
  /** Every idle agent, listed above or not. */
  total: number;
  /** Idle agents not listed one by one, by API role. */
  unlisted: { role: string; count: number }[];
  notWoken: number;
}) {
  // Several internal roles share one plain role (every reviewer kind is a "Reviewer").
  const byRole = new Map<string, number>();
  for (const row of unlisted) {
    const role = plainRole(row.role);
    byRole.set(role, (byRole.get(role) ?? 0) + row.count);
  }
  const rows = [...byRole].sort((a, b) => b[1] - a[1]);
  return (
    <div className="grid gap-2 text-[14px]">
      <p>
        <span className="tabular-nums">{formatNumber(total)}</span>{" "}
        {total === 1 ? "agent" : "agents"} <Term k="idle">idle</Term>
        {notWoken > 0 && (
          <span className="text-kumo-subtle">
            {" "}
            · {formatNumber(notWoken)} open {notWoken === 1 ? "task is" : "tasks are"} waiting for
            their agent to start
          </span>
        )}
      </p>
      {rows.length > 0 && (
        <Details label="Show idle agents by role">
          <ul className="grid max-w-80 text-[13px]" aria-label="Idle agents by role">
            {rows.map(([role, count]) => (
              <li
                key={role}
                className="flex items-baseline justify-between gap-3 border-b border-kumo-rule py-1.5 last:border-b-0"
              >
                <span>{role}</span>
                <span className="tabular-nums">{formatNumber(count)}</span>
              </li>
            ))}
          </ul>
          <p className="text-kumo-subtle">
            Agents active in the last hours are listed above and not counted here. An agent starts
            only when its task is ready.
          </p>
        </Details>
      )}
    </div>
  );
}
SleepingPool.displayName = "SleepingPool";
