import type { TaskDetail } from "../../lib/api";
import type { CandidateView, ChangeView } from "../../lib/api-change";
import { formatNumber, formatUsd, generation, truncate } from "../../lib/format";
import { type StatusFamily, StatusPill } from "../ui/status-pill";

/**
 * Change status in plain words (DESIGN.md 8.3, 12). The pill maps every Change status, including
 * the ones the shared vocabulary does not know. The sentence says where the Change stands and
 * what happens next, in one line.
 */

const CHANGE_STATUS: Record<string, { family: StatusFamily; label: string }> = {
  created: { family: "active", label: "Planning" },
  compiling: { family: "active", label: "Planning" },
  running: { family: "active", label: "Building" },
  verifying: { family: "active", label: "Checking" },
  needs_input: { family: "attention", label: "Needs input" },
  awaiting_approval: { family: "attention", label: "Needs approval" },
  budget_blocked: { family: "danger", label: "Blocked" },
  blocked: { family: "danger", label: "Blocked" },
  promoting: { family: "active", label: "Promoting" },
  releasing: { family: "active", label: "Releasing" },
  completed: { family: "ok", label: "Done" },
  failed: { family: "danger", label: "Fail" },
  cancelled: { family: "idle", label: "Cancelled" },
  not_selected: { family: "idle", label: "Not selected" },
};

export function ChangeStatusWord({ status, className }: { status: string; className?: string }) {
  const view = CHANGE_STATUS[status];
  return <StatusPill status={status} {...(view ?? {})} {...(className ? { className } : {})} />;
}
ChangeStatusWord.displayName = "ChangeStatusWord";

export type StatusLine = { text: string; family: StatusFamily };

/** The person who asked, as a name: "you", their name, or "the requester". */
export function requesterName(change: ChangeView) {
  const r = change.requester;
  if (!r) return "the requester";
  if (r.isYou) return "you";
  return r.name ?? "the requester";
}

/** First line of a recorded reason, short enough for one sentence. The full text shows below. */
const short = (reason: string | null | undefined, fallback: string) =>
  reason ? truncate(reason.split("\n")[0] ?? reason, 140) : fallback;

const plural = (n: number, word: string) => `${formatNumber(n)} ${word}${n === 1 ? "" : "s"}`;

/** One sentence on where the Change stands, from recorded state only. */
export function statusLine({
  change,
  tasks,
  candidates,
  canAnswer,
  liveGeneration,
}: {
  change: ChangeView;
  tasks: TaskDetail[];
  candidates: CandidateView[];
  canAnswer: boolean;
  /** The generation the live app serves, when the Project has a live app. */
  liveGeneration: number | null;
}): StatusLine {
  const done = tasks.filter((t) => t.status === "completed").length;
  const promoted = candidates.find((c) => c.status === "promoted");
  const verifying = candidates.filter((c) =>
    ["composing", "composed", "verifying"].includes(c.status),
  ).length;
  switch (change.status) {
    case "created":
    case "compiling":
      return { text: "Planning: splitting the request into tasks", family: "active" };
    case "needs_input":
      return canAnswer
        ? { text: "Waiting for your answer", family: "attention" }
        : { text: `Waiting for ${requesterName(change)} to answer`, family: "attention" };
    case "running":
      return {
        text:
          tasks.length === 0
            ? "Building"
            : `Building: ${formatNumber(done)} of ${plural(tasks.length, "task")} done`,
        family: "active",
      };
    case "verifying":
      return {
        text:
          verifying > 0
            ? `Checking: ${plural(verifying, "candidate")} under verification`
            : "Checking the finished work",
        family: "active",
      };
    case "awaiting_approval":
      return { text: "Waiting for approval before it ships", family: "attention" };
    case "budget_blocked":
      return {
        text: `Stopped: the ${formatUsd(change.budgetUsd)} budget is used up`,
        family: "danger",
      };
    case "blocked":
      return {
        text: `Blocked: ${short(change.blockedReason, "work cannot continue")}`,
        family: "danger",
      };
    case "promoting":
      return { text: "Shipping: advancing the canonical state", family: "active" };
    case "releasing":
      return {
        text: promoted?.promotedGeneration
          ? `Releasing ${generation(promoted.promotedGeneration)} to the live app`
          : "Releasing to the live app",
        family: "active",
      };
    case "completed": {
      const gen = promoted?.promotedGeneration ?? null;
      if (gen !== null && liveGeneration !== null && liveGeneration >= gen) {
        return { text: `Live as ${generation(gen)}`, family: "ok" };
      }
      return {
        text: gen !== null ? `Done: promoted to ${generation(gen)}` : "Done",
        family: "ok",
      };
    }
    case "failed":
      return {
        text: `Failed: ${short(change.blockedReason, "no reason was recorded")}`,
        family: "danger",
      };
    case "cancelled":
      return { text: "Cancelled: no further work runs", family: "idle" };
    case "not_selected":
      return {
        text: `Not built: ${short(change.outcome?.reason, "another request was chosen")}`,
        family: "idle",
      };
    default:
      return { text: change.status.replace(/_/g, " "), family: "idle" };
  }
}
