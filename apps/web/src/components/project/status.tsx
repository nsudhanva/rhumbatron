import { cn } from "@cloudflare/kumo";
import { type StatusFamily, StatusPill } from "../ui/status-pill";

/**
 * Change status words for the project pages (research 7.4): one plain word per Change status.
 * The shared vocabulary in components/ui/status-pill covers Tasks, checks and versions; a
 * Change reads differently ("Building", not "Running"), so its words live here.
 */

/** Change statuses that still have work in flight (protocol `ChangeStatus`). */
export const ACTIVE_CHANGE_STATUSES = new Set([
  "created",
  "compiling",
  "running",
  "verifying",
  "awaiting_approval",
  "promoting",
  "releasing",
]);

/** The headline word per Change status (research 7.4, "Status headline formulas"). */
const CHANGE_OVERRIDES: Record<string, { family: StatusFamily; label: string }> = {
  created: { family: "idle", label: "Queued" },
  compiling: { family: "active", label: "Planning" },
  running: { family: "active", label: "Building" },
  verifying: { family: "active", label: "Checking" },
  awaiting_approval: { family: "attention", label: "Needs your approval" },
  promoting: { family: "active", label: "Shipping" },
  releasing: { family: "active", label: "Publishing" },
  completed: { family: "ok", label: "Shipped" },
  failed: { family: "danger", label: "Failed" },
  budget_blocked: { family: "attention", label: "Paused" },
  cancelled: { family: "idle", label: "Cancelled" },
};

export function ChangeStatusPill({ status }: { status: string }) {
  const override = CHANGE_OVERRIDES[status];
  return <StatusPill status={status} {...(override ?? {})} />;
}
ChangeStatusPill.displayName = "ChangeStatusPill";

/**
 * Task progress: "3 of 5 tasks done" above a 4px bar that turns success when complete. With no
 * Tasks yet it reads "No tasks yet".
 */
export function TaskProgress({
  done,
  total,
  className,
}: {
  done: number;
  total: number;
  className?: string;
}) {
  if (total === 0) {
    return <p className={cn("text-[12px] text-kumo-subtle", className)}>No tasks yet</p>;
  }
  const complete = done >= total;
  return (
    <div className={cn("grid gap-1.5", className)}>
      <p className="text-[12px] text-kumo-subtle tabular-nums">
        {done} of {total} tasks done
      </p>
      <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-kumo-recessed">
        <span
          className={cn(
            "block h-full rounded-full transition-[width] duration-(--rh-dur-bar)",
            complete ? "bg-kumo-success" : "bg-accent-500",
          )}
          style={{ width: `${Math.min(100, (done / total) * 100)}%` }}
        />
      </span>
    </div>
  );
}
TaskProgress.displayName = "TaskProgress";
