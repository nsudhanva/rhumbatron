import { cn } from "@cloudflare/kumo";
import {
  CheckCircle,
  Circle,
  CircleNotch,
  Clock,
  HandPalm,
  type Icon,
  MinusCircle,
  PauseCircle,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";

/**
 * Status families and the shared status vocabulary (docs/ux/research-2026-10-09.md 7.4, 8.4).
 * Every status shows an icon AND a plain word, so color is never the only signal.
 *
 *   ok        it finished and it is good               Done, Passed, Shipped, Approved, Live
 *   active    working on it right now (spinning icon)  Working, Planning, Checking, Shipping
 *   attention it needs a person, or something is missing
 *                                                      Needs your approval, Paused, Not run,
 *                                                      Out of date, Two approaches
 *   danger    it failed or lost                        Failed, Couldn't run, Set aside, Blocked
 *   idle      not started, skipped or resting          Queued, Ready, Skipped, Cancelled, Idle
 *
 * Icons: ok CheckCircle; active CircleNotch (spins, the only looping motion); attention
 * WarningCircle, or HandPalm for an approval wait, PauseCircle for paused, Clock for waiting;
 * danger XCircle; idle Circle, or MinusCircle for skipped and cancelled.
 */
export type StatusFamily = "ok" | "attention" | "danger" | "active" | "idle";

type Glyph =
  | "check"
  | "spin"
  | "gap"
  | "approval"
  | "paused"
  | "waiting"
  | "fail"
  | "dot"
  | "minus";

type StatusView = { family: StatusFamily; label: string; glyph?: Glyph };

const GLYPHS: Record<Glyph, Icon> = {
  check: CheckCircle,
  spin: CircleNotch,
  gap: WarningCircle,
  approval: HandPalm,
  paused: PauseCircle,
  waiting: Clock,
  fail: XCircle,
  dot: Circle,
  minus: MinusCircle,
};

/** The icon a family uses when the status has no more specific one. */
const FAMILY_GLYPH: Record<StatusFamily, Glyph> = {
  ok: "check",
  active: "spin",
  attention: "gap",
  danger: "fail",
  idle: "dot",
};

const ok = (label: string): StatusView => ({ family: "ok", label });
const active = (label: string): StatusView => ({ family: "active", label });
const attention = (label: string, glyph?: Glyph): StatusView =>
  glyph ? { family: "attention", label, glyph } : { family: "attention", label };
const danger = (label: string): StatusView => ({ family: "danger", label });
const idle = (label: string, glyph?: Glyph): StatusView =>
  glyph ? { family: "idle", label, glyph } : { family: "idle", label };

const VOCABULARY: Record<string, StatusView> = {
  // ok
  completed: ok("Done"),
  done: ok("Done"),
  succeeded: ok("Done"),
  success: ok("Done"),
  pass: ok("Passed"),
  passed: ok("Passed"),
  checked_supported: ok("Passed"),
  verified: ok("Passed"),
  promoted: ok("Shipped"),
  deployed: ok("Deployed"),
  approved: ok("Approved"),
  accepted: ok("Accepted"),
  healthy: ok("Healthy"),
  live: ok("Live"),
  // active
  running: active("Working"),
  started: active("Working"),
  in_progress: active("Working"),
  active: active("Working"),
  assigned: active("Starting"),
  compiling: active("Planning"),
  composing: active("Assembling"),
  composed: active("Ready for checks"),
  verifying: active("Checking"),
  promoting: active("Shipping"),
  releasing: active("Publishing"),
  deploying: active("Deploying"),
  building: active("Building"),
  // attention
  awaiting_approval: attention("Needs your approval", "approval"),
  "awaiting approval": attention("Needs your approval", "approval"),
  approval_requested: attention("Needs your approval", "approval"),
  pending_approval: attention("Needs your approval", "approval"),
  waiting: attention("Waiting", "waiting"),
  budget_blocked: attention("Paused", "paused"),
  paused: attention("Paused", "paused"),
  stale: attention("Out of date"),
  not_checked: attention("Not run"),
  gap: attention("Not run"),
  suspected: attention("Possible conflict"),
  confirmed: attention("Two approaches"),
  fork_required: attention("Two approaches"),
  degraded: attention("Degraded"),
  reconnecting: attention("Reconnecting"),
  // danger
  failed: danger("Failed"),
  fail: danger("Failed"),
  error: danger("Couldn't run"),
  errored: danger("Couldn't run"),
  // Approval rejections pass `label="Rejected"`: "Set aside" is the version that lost.
  rejected: danger("Set aside"),
  blocked: danger("Blocked"),
  timed_out: danger("Timed out"),
  smoke_failed: danger("Smoke check failed"),
  unsupported: danger("Not backed by a check"),
  offline: danger("Offline"),
  // idle
  queued: idle("Queued"),
  created: idle("Queued"),
  pending: idle("Queued"),
  ready: idle("Ready"),
  skipped: idle("Skipped", "minus"),
  cancelled: idle("Cancelled", "minus"),
  canceled: idle("Cancelled", "minus"),
  superseded: idle("Superseded", "minus"),
  sleeping: idle("Idle"),
  asleep: idle("Idle"),
  idle: idle("Idle"),
  none: idle("None"),
  resolved: idle("Resolved"),
  checked_no_signal: idle("No result"),
};

/** Sentence case for an unknown status: `needs_review` -> `Needs review`. */
function sentenceCase(status: string) {
  const words = status.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words[0]?.toUpperCase() + words.slice(1) : "Unknown";
}

/** Maps any domain status string to its family and plain word. Unknown values are idle. */
export function statusView(status: string): StatusView {
  return VOCABULARY[status.trim().toLowerCase()] ?? { family: "idle", label: sentenceCase(status) };
}

/** Pill fill and text per family. */
const PILL: Record<StatusFamily, string> = {
  ok: "bg-kumo-success-tint text-kumo-success",
  attention: "bg-kumo-warning-tint text-kumo-warning",
  danger: "bg-kumo-danger-tint text-kumo-danger",
  active: "bg-kumo-info-tint text-kumo-info",
  idle: "bg-tone-200 text-kumo-subtle",
};

/** Solid fill per family, for segments, dots and bars. */
export const FAMILY_FILL: Record<StatusFamily, string> = {
  ok: "bg-kumo-success",
  attention: "bg-kumo-warning",
  danger: "bg-kumo-danger",
  active: "bg-kumo-info",
  idle: "bg-tone-300",
};

/** Text color per family, for log lines, captions and result words. */
export const FAMILY_TEXT: Record<StatusFamily, string> = {
  ok: "text-kumo-success",
  attention: "text-kumo-warning",
  danger: "text-kumo-danger",
  active: "text-kumo-info",
  idle: "text-kumo-subtle",
};

/** The glyph for a family, refined by the status word when the status belongs to that family. */
function glyphFor(family: StatusFamily, status?: string): Glyph {
  if (status !== undefined) {
    const view = statusView(status);
    if (view.family === family && view.glyph) return view.glyph;
  }
  return FAMILY_GLYPH[family];
}

/**
 * The status icon alone, in its family color, for timelines and headers that show the word
 * elsewhere. Pass `status` to get the specific icon (HandPalm for an approval wait, PauseCircle
 * for paused, MinusCircle for skipped); pass `family` alone for the family icon. Decorative:
 * always put the status word next to it.
 *
 *   <StatusIcon status={change.status} size={20} />
 *   <StatusIcon family="danger" />
 */
export function StatusIcon({
  status,
  family,
  size = 16,
  className,
}: {
  status?: string;
  family?: StatusFamily;
  size?: number;
  className?: string;
}) {
  const resolved = family ?? (status !== undefined ? statusView(status).family : "idle");
  const glyph = glyphFor(resolved, status);
  const Glyph = GLYPHS[glyph];
  return (
    <Glyph
      size={size}
      aria-hidden
      className={cn("shrink-0", glyph === "spin" && "rh-spin", FAMILY_TEXT[resolved], className)}
    />
  );
}
StatusIcon.displayName = "StatusIcon";

export type StatusPillProps = {
  /** A domain status such as `completed`, `verifying`, `not_checked`. */
  status: string;
  /** Overrides the vocabulary word (keep it to one to three words). */
  label?: string;
  /** Overrides the vocabulary family (the icon follows the family). */
  family?: StatusFamily;
  className?: string;
};

/**
 * Status pill: icon + plain word on the family tint, 6px radius (so it does not read as a
 * button), 12px weight 500. Place it at the end of a row or right after a title.
 *
 *   <StatusPill status={candidate.status} />
 *   <StatusPill status="rejected" label="Rejected" />
 *   <StatusPill status="custom" label="Over budget" family="danger" />
 */
export function StatusPill({ status, label, family, className }: StatusPillProps) {
  const view = statusView(status);
  const resolved = family ?? view.family;
  return (
    <span
      className={cn(
        "type-pill inline-flex w-fit shrink-0 items-center gap-1 rounded-md px-2 py-0.5 whitespace-nowrap",
        PILL[resolved],
        className,
      )}
    >
      <StatusIcon status={status} family={resolved} size={14} />
      {label ?? view.label}
    </span>
  );
}
StatusPill.displayName = "StatusPill";
