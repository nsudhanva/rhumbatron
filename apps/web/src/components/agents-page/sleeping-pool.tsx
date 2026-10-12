import { formatNumber } from "../../lib/format";

/**
 * Sleeping agents that are not listed one by one, aggregated by role, as a
 * horizontal bar list: label, bar, right-aligned mono value. Every bar has its
 * value beside it. Bars use the neutral series: asleep is idle, not a state that needs attention.
 */
export function SleepingPool({
  unlisted,
  notWoken,
}: {
  unlisted: { role: string; count: number }[];
  notWoken: number;
}) {
  const max = Math.max(1, ...unlisted.map((r) => r.count));
  return (
    <div className="grid gap-3">
      {unlisted.length === 0 ? (
        <p className="text-[13px] text-kumo-subtle">
          Every sleeping agent is listed above. Older sleeping agents collect here by role.
        </p>
      ) : (
        <ul className="grid gap-2" aria-label="Sleeping agents by role">
          {unlisted.map((row) => (
            <li
              key={row.role}
              className="grid grid-cols-[minmax(0,160px)_minmax(0,1fr)_64px] items-center gap-3 text-[13px]"
            >
              <span className="truncate">{row.role}</span>
              <span aria-hidden className="h-2 bg-kumo-recessed">
                <span
                  className="block h-full bg-tone-400 transition-[width] duration-(--rh-dur-bar)"
                  style={{ width: `${(row.count / max) * 100}%` }}
                />
              </span>
              <span className="text-right font-mono text-[12px] tabular-nums">
                {formatNumber(row.count)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[12px] text-kumo-subtle">
        <span className="font-mono tabular-nums">{formatNumber(notWoken)}</span> open{" "}
        {notWoken === 1 ? "Task has" : "Tasks have"} an agent that has not woken. Agents wake only
        when their Task becomes ready.
      </p>
    </div>
  );
}
SleepingPool.displayName = "SleepingPool";
