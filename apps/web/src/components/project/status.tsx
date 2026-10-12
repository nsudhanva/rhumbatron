import { cn } from "@cloudflare/kumo";
import { EMPTY } from "../../lib/format";
import { type StatusFamily, StatusPill } from "../ui/status-pill";

/**
 * Project and Change status words for the project pages. The shared vocabulary in
 * components/ui/status-pill covers most values; these fill the gaps without changing it.
 */

/** Change statuses that still have work in flight (protocol `ChangeStatus`). */
export const ACTIVE_CHANGE_STATUSES = new Set([
  "created",
  "compiling",
  "running",
  "verifying",
  "awaiting_approval",
  "needs_input",
  "promoting",
  "releasing",
]);

/** Change statuses the shared vocabulary does not know yet. */
const CHANGE_OVERRIDES: Record<string, { family: StatusFamily; label: string }> = {
  promoting: { family: "active", label: "Promoting" },
  releasing: { family: "active", label: "Releasing" },
  not_selected: { family: "idle", label: "Not selected" },
  awaiting_approval: { family: "attention", label: "Waiting for owner" },
  needs_input: { family: "attention", label: "Needs input" },
  proposed: { family: "attention", label: "Proposed" },
  declined: { family: "idle", label: "Declined" },
};

export function ChangeStatusPill({ status }: { status: string }) {
  const override = CHANGE_OVERRIDES[status];
  return <StatusPill status={status} {...(override ?? {})} />;
}
ChangeStatusPill.displayName = "ChangeStatusPill";

/**
 * A Project is `active` or `archived`. "Active" here means open for work, not "running right
 * now", so it reads as ok rather than the inverted ink of the active family.
 */
const PROJECT_STATUS: Record<string, { family: StatusFamily; label: string }> = {
  active: { family: "ok", label: "Active" },
  archived: { family: "idle", label: "Archived" },
};

export function ProjectStatusPill({ status }: { status: string }) {
  return <StatusPill status={status} {...(PROJECT_STATUS[status] ?? {})} />;
}
ProjectStatusPill.displayName = "ProjectStatusPill";

/**
 * Task progress for a table cell (DESIGN.md 9.1): a 4px inline bar with the mono "done / total"
 * beside it. Complete turns `success`. With no Tasks yet the cell reads as an em dash.
 */
export function TaskProgress({ done, total }: { done: number; total: number }) {
  if (total === 0) {
    return <span className="font-mono text-[12px] text-kumo-subtle">{EMPTY}</span>;
  }
  const complete = done >= total;
  return (
    <span className="inline-flex w-full max-w-40 items-center justify-end gap-2">
      <span aria-hidden className="h-1 min-w-10 grow bg-kumo-recessed">
        <span
          className={cn(
            "block h-full transition-[width] duration-(--rh-dur-bar)",
            complete ? "bg-kumo-success" : "bg-kumo-ink",
          )}
          style={{ width: `${Math.min(100, (done / total) * 100)}%` }}
        />
      </span>
      <span className="font-mono text-[12px] whitespace-nowrap tabular-nums">
        {done} / {total}
        <span className="sr-only"> Tasks done</span>
      </span>
    </span>
  );
}
TaskProgress.displayName = "TaskProgress";
