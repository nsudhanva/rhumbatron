import { Circle, LockSimple } from "@phosphor-icons/react";
import type { TaskDetail } from "../../lib/api";

/** Recorded model spend and calls across every run of the Change. Null before the first run. */
export function changeSpend(tasks: TaskDetail[]) {
  const runs = tasks.flatMap((t) => t.runs);
  if (runs.length === 0) return null;
  return {
    calls: runs.reduce((sum, r) => sum + r.modelCalls, 0),
    costUsd: runs.reduce((sum, r) => sum + r.costUsd, 0),
  };
}

/**
 * "Done when" as a checklist. The API does not record which check proved which item, so every
 * item shows an open circle rather than a claimed tick.
 */
export function CriteriaList({ items }: { items: string[] }) {
  if (items.length === 0) {
    return <p className="text-[13px] text-kumo-subtle">The planner has not set these yet.</p>;
  }
  return (
    <ul className="grid gap-1.5">
      {items.map((item) => (
        <li key={item} className="flex items-start gap-2 text-[14px]">
          <Circle aria-hidden size={16} className="mt-0.5 shrink-0 text-kumo-subtle" />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}
CriteriaList.displayName = "CriteriaList";

/** "Must not change": each item with a lock icon. */
export function InvariantList({ items }: { items: string[] }) {
  if (items.length === 0) {
    return <p className="text-[13px] text-kumo-subtle">Nothing is protected for this change.</p>;
  }
  return (
    <ul className="grid gap-1.5">
      {items.map((item) => (
        <li key={item} className="flex items-start gap-2 text-[14px]">
          <LockSimple aria-hidden size={16} className="mt-0.5 shrink-0 text-kumo-subtle" />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}
InvariantList.displayName = "InvariantList";
