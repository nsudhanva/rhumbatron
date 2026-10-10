import type { CandidateDetail, ConflictDetail, TaskDetail } from "../../lib/api";
import { formatUsd, generation, plural, timeAgo } from "../../lib/format";
import { type CheckRow, criterion, p95Budget, REASON_WORDS } from "../candidate/model";
import type { StatusFamily } from "../ui/status-pill";

/**
 * The Change page status machine (docs/ux/research-2026-10-09.md 7.4 and 7.5): one icon, one
 * word, one sentence and at most one primary action, derived only from recorded state (Change
 * status, Tasks, conflicts, versions with their check rows, approval and release). Pure, so the
 * header and the timeline step always agree and the rules are unit-tested.
 */

/** One version (Candidate) with its check rows and its plain label ("Version A"). */
export type VersionView = { candidate: CandidateDetail; rows: CheckRow[]; label: string };

export type PrimaryKind =
  | "run-checks"
  | "review-approve"
  | "ship"
  | "open-app"
  | "view-release"
  | "see-failed"
  | "restart"
  | "restart-larger";

/** The timeline step a "See what failed" action opens. */
export type StepId = "planned" | "agents" | "checks" | "approval" | "shipped";

export type Headline = {
  family: StatusFamily;
  /** A status word for the shared `StatusIcon` (its icon, not its label). */
  iconStatus: string;
  word: string;
  sentence: string;
  primary: { kind: PrimaryKind; label: string } | null;
  /** The version the page talks about (shipped, ready, or latest). */
  version: VersionView | null;
  failedStep: StepId | null;
};

export type HeadlineInput = {
  status: string;
  riskTier: string | null | undefined;
  baseGeneration: number;
  budgetUsd: number;
  spentUsd: number;
  updatedAt?: string | undefined;
  tasks: TaskDetail[];
  conflicts: Pick<ConflictDetail, "state" | "resource">[];
  versions: VersionView[];
  /** Files changed by the shipped version, when the workspace recorded them. */
  filesChanged: number | null;
  now: number;
};

const OPEN_TASK = new Set<TaskDetail["status"]>([
  "pending",
  "ready",
  "assigned",
  "running",
  "blocked",
]);
const ACTIVE_VERSION = new Set<CandidateDetail["status"]>(["composing", "composed", "verifying"]);

/** `project:acme:wishlist:membership` -> `wishlist membership`. */
export function readableArea(resource: string) {
  return resource.split(":").slice(-2).join(" ").replace(/[-_]+/g, " ").trim();
}

const byNewest = (a: VersionView, b: VersionView) =>
  Date.parse(b.candidate.createdAt) - Date.parse(a.candidate.createdAt);

/** A shipped version, else the newest one ready to ship, else the newest. */
export function pickVersion(versions: VersionView[]): VersionView | null {
  const sorted = [...versions].sort(byNewest);
  return (
    sorted.find((v) => v.candidate.status === "promoted") ??
    sorted.find((v) => v.candidate.status === "verified" && v.candidate.gate?.promotable) ??
    sorted[0] ??
    null
  );
}

export const isReady = (v: VersionView) =>
  v.candidate.status === "verified" && v.candidate.gate?.promotable === true;

/** The run failure reason in words, from the outcome or the failure kind. */
export function failureReason(task: TaskDetail): string {
  const run = task.runs.at(-1);
  if (run?.outcome && "reason" in run.outcome) return run.outcome.reason;
  return (run?.failureKind ?? "no reason was recorded").replace(/_/g, " ");
}

/** The first required check that did not pass, as one phrase. */
export function firstProblem(v: VersionView): string | null {
  const row =
    v.rows.find((r) => r.required && r.verdict === "fail") ??
    v.rows.find((r) => r.required && r.verdict === "gap");
  if (!row) return v.candidate.statusReason;
  const title = criterion(row, p95Budget(v.candidate)).title;
  const detail = row.record?.summary ?? REASON_WORDS[row.reason ?? "missing"];
  return `${title}: ${detail}`.replace(/\.$/, "");
}

const sentenceEnd = (text: string) => text.replace(/[.\s]*$/, ".");

export function changeHeadline(input: HeadlineInput): Headline {
  const { status, tasks, versions } = input;
  const version = pickVersion(versions);
  const label = version?.label ?? "The version";
  const base = version?.candidate.baseGeneration ?? input.baseGeneration;
  const next = version?.candidate.promotedGeneration ?? base + 1;
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "completed").length;
  const open = tasks.filter((t) => OPEN_TASK.has(t.status)).length;
  const active = tasks.filter((t) => t.runs.at(-1)?.status === "running").length;
  const risk = input.riskTier ? `${input.riskTier} risk changes` : "changes like this";

  const make = (
    family: StatusFamily,
    iconStatus: string,
    word: string,
    sentence: string,
    primary: Headline["primary"] = null,
    failedStep: StepId | null = null,
  ): Headline => ({ family, iconStatus, word, sentence, primary, version, failedStep });
  const restart = { kind: "restart", label: "Start again with this goal" } as const;

  if (status === "cancelled") {
    const when = input.updatedAt ? ` ${timeAgo(input.updatedAt, input.now)}` : "";
    return make("idle", "cancelled", "Cancelled", `Stopped${when}. Nothing was shipped.`, restart);
  }
  if (status === "budget_blocked") {
    return make(
      "attention",
      "budget_blocked",
      "Paused",
      `Budget reached: ${formatUsd(input.spentUsd)} of ${formatUsd(input.budgetUsd)}. Work is saved.`,
      { kind: "restart-larger", label: "Start again with a larger budget" },
    );
  }
  if (status === "failed") {
    const task = tasks.find((t) => t.status === "failed");
    if (task) {
      return make(
        "danger",
        "failed",
        "Failed",
        sentenceEnd(`${task.title} failed: ${failureReason(task)}`),
        { kind: "see-failed", label: "See what failed" },
        "agents",
      );
    }
    const problem = version ? firstProblem(version) : null;
    return make(
      "danger",
      "failed",
      "Failed",
      problem
        ? sentenceEnd(`No version passed the required checks: ${problem}`)
        : "The change stopped before it shipped.",
      version ? { kind: "see-failed", label: "See what failed" } : restart,
      version ? "checks" : null,
    );
  }
  if (status === "completed") {
    const release = version?.candidate.release;
    const shipped = version?.candidate.promotedGeneration ?? next;
    if (release?.status === "queued" || release?.status === "building") {
      return make(
        "active",
        "running",
        "Publishing",
        `Deploying ${generation(shipped)} to production.`,
      );
    }
    if (release?.status === "failed" || release?.status === "smoke_failed") {
      return make(
        "danger",
        "failed",
        "Not deployed",
        `${generation(shipped)} was saved but did not deploy. Your previous app is still live.`,
        { kind: "see-failed", label: "See details" },
        "shipped",
      );
    }
    const files =
      input.filesChanged === null ? "" : ` ${plural(input.filesChanged, "file")} changed.`;
    if (release?.status === "deployed") {
      return make(
        "ok",
        "completed",
        "Shipped",
        `${generation(shipped)} is live.${files}`,
        release.url
          ? { kind: "open-app", label: "Open app" }
          : { kind: "view-release", label: "View release" },
      );
    }
    // No deployment recorded: say what is known and never claim "live".
    return make(
      "ok",
      "completed",
      "Shipped",
      `${generation(shipped)} is saved.${files}`,
      version ? { kind: "view-release", label: "View release" } : null,
    );
  }
  if (status === "promoting") {
    return make("active", "running", "Shipping", `Saving ${generation(next)}.`);
  }
  if (status === "releasing") {
    return make("active", "running", "Publishing", `Deploying ${generation(next)} to production.`);
  }
  if (status === "created") {
    return make("idle", "created", "Queued", "Getting started. Rhumbatron is reading your goal.");
  }
  if (status === "compiling" || (total === 0 && status === "running")) {
    return make("active", "running", "Planning", "Splitting your goal into tasks.");
  }

  // running, verifying, awaiting_approval: the versions decide.
  if (version?.candidate.approval?.decision === "rejected") {
    return make(
      "danger",
      "failed",
      "Rejected",
      `${label} was rejected by a person, so it will not ship.`,
      restart,
      "approval",
    );
  }
  if (version && isReady(version)) {
    const granted = version.candidate.approval?.decision === "granted";
    if (version.candidate.approvalRequired && !granted) {
      return make(
        "attention",
        "awaiting_approval",
        "Needs your approval",
        `${label} passed every required check. A person must approve ${risk} before they ship.`,
        { kind: "review-approve", label: "Review and approve" },
      );
    }
    return make("ok", "completed", "Ready to ship", `${label} passed every required check.`, {
      kind: "ship",
      label: `Ship ${generation(next)}`,
    });
  }
  const checking = versions.filter((v) => ACTIVE_VERSION.has(v.candidate.status));
  if (checking.length > 0) {
    const [only] = checking;
    const target =
      checking.length === 1 && only
        ? `${plural(only.rows.length, "check")} on ${only.label}`
        : `checks on ${checking.length} versions`;
    return make("active", "running", "Checking", `Running ${target}.`);
  }
  if (open > 0) {
    const working =
      active === 0
        ? `${done} of ${total} tasks done. The next agent starts soon.`
        : `${active === 1 ? "1 agent is" : `${active} agents are`} working. ${done} of ${total} tasks done.`;
    const conflict = input.conflicts.find(
      (c) => c.state === "fork_required" || c.state === "confirmed",
    );
    const fork = conflict
      ? ` Two approaches were found for ${readableArea(conflict.resource)}; both will be built and checked.`
      : "";
    return make("active", "running", "Building", `${working}${fork}`);
  }
  if (version && version.candidate.status === "rejected") {
    const problem = firstProblem(version);
    return make(
      "danger",
      "failed",
      "Failed",
      sentenceEnd(`No version passed the required checks${problem ? `: ${problem}` : ""}`),
      { kind: "see-failed", label: "See what failed" },
      "checks",
    );
  }
  const runChecks = { kind: "run-checks", label: "Run checks" } as const;
  if (version?.candidate.status === "stale") {
    return make(
      "ok",
      "completed",
      "Code ready",
      "Another change shipped first. Run the checks again to rebuild the version on the current release.",
      runChecks,
    );
  }
  return make(
    "ok",
    "completed",
    "Code ready",
    `All ${total} tasks are done. Start the checks to build a version.`,
    runChecks,
  );
}
