import { cn } from "@cloudflare/kumo";

/**
 * Status families (DESIGN.md 2.6) and the shared status vocabulary (8.3).
 *
 *   ok        finished and correct                      Done, Pass, Verified, Promoted
 *   attention waiting on a person, slow, stale, gap     Waiting, Stale, Gap
 *   danger    failed, rejected, blocked, over budget    Fail, Rejected, Blocked, Error
 *   active    in progress right now (solid ink)         Running, Verifying
 *   idle      queued, skipped, asleep, superseded       Queued, Skipped, Cancelled
 *
 * Status is a word, not a color: the pill always shows the label.
 */
export type StatusFamily = "ok" | "attention" | "danger" | "active" | "idle";

type StatusView = { family: StatusFamily; label: string };

const VOCABULARY: Record<string, StatusView> = {
  // ok
  completed: { family: "ok", label: "Done" },
  done: { family: "ok", label: "Done" },
  succeeded: { family: "ok", label: "Done" },
  success: { family: "ok", label: "Done" },
  pass: { family: "ok", label: "Pass" },
  passed: { family: "ok", label: "Pass" },
  verified: { family: "ok", label: "Verified" },
  promoted: { family: "ok", label: "Promoted" },
  approved: { family: "ok", label: "Approved" },
  accepted: { family: "ok", label: "Accepted" },
  healthy: { family: "ok", label: "Healthy" },
  live: { family: "ok", label: "Live" },
  deployed: { family: "ok", label: "Deployed" },
  checked_supported: { family: "ok", label: "Supported" },
  // active
  running: { family: "active", label: "Running" },
  started: { family: "active", label: "Running" },
  in_progress: { family: "active", label: "Running" },
  active: { family: "active", label: "Running" },
  assigned: { family: "active", label: "Assigned" },
  compiling: { family: "active", label: "Compiling" },
  composing: { family: "active", label: "Composing" },
  composed: { family: "active", label: "Composed" },
  verifying: { family: "active", label: "Verifying" },
  deploying: { family: "active", label: "Deploying" },
  building: { family: "active", label: "Building" },
  // attention
  waiting: { family: "attention", label: "Waiting" },
  awaiting_approval: { family: "attention", label: "Waiting" },
  "awaiting approval": { family: "attention", label: "Waiting" },
  approval_requested: { family: "attention", label: "Waiting" },
  pending_approval: { family: "attention", label: "Waiting" },
  stale: { family: "attention", label: "Stale" },
  degraded: { family: "attention", label: "Degraded" },
  reconnecting: { family: "attention", label: "Reconnecting" },
  not_checked: { family: "attention", label: "Gap" },
  gap: { family: "attention", label: "Gap" },
  suspected: { family: "attention", label: "Suspected" },
  // danger
  failed: { family: "danger", label: "Fail" },
  fail: { family: "danger", label: "Fail" },
  error: { family: "danger", label: "Error" },
  errored: { family: "danger", label: "Error" },
  rejected: { family: "danger", label: "Rejected" },
  blocked: { family: "danger", label: "Blocked" },
  budget_blocked: { family: "danger", label: "Blocked" },
  timed_out: { family: "danger", label: "Timed out" },
  unsupported: { family: "danger", label: "Unsupported" },
  confirmed: { family: "danger", label: "Conflict" },
  fork_required: { family: "danger", label: "Fork required" },
  offline: { family: "danger", label: "Offline" },
  // idle
  queued: { family: "idle", label: "Queued" },
  created: { family: "idle", label: "Queued" },
  pending: { family: "idle", label: "Queued" },
  ready: { family: "idle", label: "Ready" },
  skipped: { family: "idle", label: "Skipped" },
  cancelled: { family: "idle", label: "Cancelled" },
  canceled: { family: "idle", label: "Cancelled" },
  superseded: { family: "idle", label: "Superseded" },
  sleeping: { family: "idle", label: "Asleep" },
  asleep: { family: "idle", label: "Asleep" },
  idle: { family: "idle", label: "Idle" },
  none: { family: "idle", label: "None" },
  resolved: { family: "idle", label: "Resolved" },
  checked_no_signal: { family: "idle", label: "No signal" },
};

/** Sentence case for an unknown status: `needs_review` -> `Needs review`. */
function sentenceCase(status: string) {
  const words = status.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words[0]?.toUpperCase() + words.slice(1) : "Unknown";
}

/** Maps any domain status string to its family and short label. Unknown values are idle. */
export function statusView(status: string): StatusView {
  return VOCABULARY[status.trim().toLowerCase()] ?? { family: "idle", label: sentenceCase(status) };
}

/** Pill fill and text per family. */
const PILL: Record<StatusFamily, string> = {
  ok: "bg-kumo-success-tint text-kumo-success",
  attention: "bg-kumo-warning-tint text-kumo-warning",
  danger: "bg-accent-100 text-kumo-danger",
  active: "bg-kumo-ink text-kumo-inverse",
  idle: "bg-tone-200 text-tone-800",
};

/** Solid fill per family, for segments, square dots and bars. */
export const FAMILY_FILL: Record<StatusFamily, string> = {
  ok: "bg-kumo-success",
  attention: "bg-kumo-warning",
  danger: "bg-accent-500",
  active: "bg-kumo-ink",
  idle: "bg-tone-300",
};

/** Text color per family, for log lines, captions and result words. */
export const FAMILY_TEXT: Record<StatusFamily, string> = {
  ok: "text-kumo-success",
  attention: "text-kumo-warning",
  danger: "text-kumo-danger",
  active: "text-kumo-default",
  idle: "text-kumo-subtle",
};

export type StatusPillProps = {
  /** A domain status such as `completed`, `verifying`, `not_checked`. */
  status: string;
  /** Overrides the vocabulary label (keep it to one or two words). */
  label?: string;
  /** Overrides the vocabulary family. */
  family?: StatusFamily;
  className?: string;
};

/**
 * Square status pill, 11px weight 600 (DESIGN.md 8.3). Place it at the end of a row or right
 * after the ID in a title line.
 *
 *   <StatusPill status={candidate.status} />
 *   <StatusPill status="custom" label="Over budget" family="danger" />
 */
export function StatusPill({ status, label, family, className }: StatusPillProps) {
  const view = statusView(status);
  const resolved = family ?? view.family;
  return (
    <span
      className={cn(
        "type-pill inline-flex w-fit shrink-0 items-center px-2 py-0.5 whitespace-nowrap",
        PILL[resolved],
        className,
      )}
    >
      {label ?? view.label}
    </span>
  );
}
StatusPill.displayName = "StatusPill";
