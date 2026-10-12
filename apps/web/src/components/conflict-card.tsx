import { GitFork, Warning } from "@phosphor-icons/react";
import type { ConflictDetail, ConflictIntent, ConflictSignal } from "../lib/api";
import { Disclosure } from "./change/disclosure";
import { StatusPill } from "./ui/status-pill";
import { Tag, type TagVariant } from "./ui/tag";

/**
 * One semantic conflict between two Intents: the shared
 * resource, both designs side by side, the incompatible signals (hard first), and what happens
 * next. Git would merge both designs; this block shows why Rhumbatron does not. An open conflict
 * carries the accent bar because it needs a decision; a resolved one does not.
 */

const SEVERITY_TAG: Record<ConflictSignal["severity"], TagVariant> = {
  hard: "accent",
  soft: "outline",
  benign: "neutral",
};

const SIGNAL_LABEL: Record<ConflictSignal["kind"], string> = {
  contract_conflict: "Contract",
  contract_overlap: "Contract overlap",
  data_model_conflict: "Data model",
  data_overlap: "Data overlap",
  assumption_conflict: "Assumption",
  invariant_reference: "Protected invariant",
  resource_overlap: "Resource overlap",
  file_overlap: "File overlap",
};

function nextStep(conflict: ConflictDetail): { label: string; detail: string } {
  const fork = conflict.forkDecision;
  if (fork.kind === "fork") return { label: "Fork 2 Candidates", detail: fork.reason };
  if (fork.kind === "blocked") {
    return {
      label: "Fork blocked",
      detail: `A fork would pass the limit of ${fork.maxCandidates} Candidates per Change.`,
    };
  }
  if (fork.reason === "needs_review") {
    return {
      label: "Review",
      detail: "The overlap is not decisive. A reviewer must confirm or dismiss it.",
    };
  }
  return { label: "No fork", detail: "No fork is needed." };
}

/** One model review as the agents Worker stores it (`review_json.reviews.<tier>`, P9-05, P9-06). */
type ModelReview = {
  status: "reserved" | "done" | "failed" | "refused";
  reason?: string;
  verdict?: string | null;
  rationale?: string;
  citations?: string[];
  support?: "supported" | "unsupported";
  outcome?: string;
  deferred?: boolean;
};

type ReviewWithModels = ConflictDetail["review"] & {
  attention?: "human";
  reviews?: Partial<Record<"sonnet" | "opus", ModelReview>>;
};

const VERDICT_LABEL: Record<string, string> = {
  benign_overlap: "Benign overlap",
  confirmed_conflict: "Confirmed conflict",
  fork_candidates: "Fork Candidates",
  needs_more_evidence: "Needs more evidence",
  escalate_to_human: "Escalate to a person",
};

/** What code did with the verdict. A model verdict never changes state on its own. */
function reviewEffect(review: ModelReview): string {
  if (review.status === "reserved") return "Review running.";
  if (review.status === "refused") return `Not run: ${review.reason ?? "limit reached"}.`;
  if (review.status === "failed") return `Call failed (${review.reason ?? "error"}). Rules decide.`;
  if (!review.verdict) return "Output did not match the contract. Ignored.";
  if (review.deferred) return "Recorded; Opus decides.";
  if (review.support === "unsupported") return "Unsupported citations. State unchanged.";
  return review.outcome?.startsWith("rejected_")
    ? `Not applied (${review.outcome.slice(9).replace(/_/g, " ")}).`
    : `Applied (${(review.outcome ?? "").replace(/_/g, " ")}).`;
}

function ModelReviews({ review }: { review: ReviewWithModels }) {
  const rows = (["sonnet", "opus"] as const).flatMap((tier) => {
    const r = review.reviews?.[tier];
    return r ? [{ tier, r }] : [];
  });
  if (rows.length === 0 && !review.attention) return null;
  return (
    <div className="grid gap-1">
      <h4 className="type-label text-kumo-subtle">Model review</h4>
      {review.attention === "human" && (
        <p className="text-[12px] font-semibold text-kumo-accent">
          A person must decide this conflict.
        </p>
      )}
      <ul className="grid">
        {rows.map(({ tier, r }) => (
          <li
            key={tier}
            className="grid gap-1 border-b border-kumo-rule py-1.5 text-[12px] last:border-b-0"
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px]">{tier}</span>
              {r.verdict && <Tag variant="outline">{VERDICT_LABEL[r.verdict] ?? r.verdict}</Tag>}
              {r.support === "unsupported" && <Tag variant="accent">Unsupported</Tag>}
              <span className="text-kumo-subtle">{reviewEffect(r)}</span>
            </span>
            {r.rationale && <span className="min-w-0">{r.rationale}</span>}
            {r.citations && r.citations.length > 0 && (
              <span className="font-mono text-[11px] break-all text-kumo-subtle">
                cites {r.citations.join(", ")}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function IntentColumn({ intent }: { intent: ConflictIntent }) {
  return (
    <div className="grid min-w-0 content-start gap-2 bg-kumo-base p-3">
      <div className="grid gap-0.5">
        <span className="font-mono text-[11px] text-kumo-subtle">
          {intent.taskKey || intent.taskId} · Intent
        </span>
        <span className="text-[14px] font-semibold">{intent.title || "Task"}</span>
      </div>
      <p className="text-[13px]">{intent.summary}</p>
      {intent.assumptions.length > 0 && (
        <div className="grid gap-1">
          <h4 className="type-label text-kumo-subtle">Assumptions</h4>
          <ul className="grid">
            {intent.assumptions.map((item) => (
              <li key={item} className="border-b border-kumo-rule py-1 text-[12px] last:border-b-0">
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One-line summary of a conflict for a collapsed list row. */
export function conflictLine(conflict: ConflictDetail) {
  const [left, right] = conflict.intents;
  const name = (i: ConflictIntent) => i.title || i.taskKey || "Task";
  return `${name(left)} vs ${name(right)} on ${conflict.resource}`;
}

/** The strongest signal's label, for the collapsed row. */
export function conflictKind(conflict: ConflictDetail) {
  const strongest = conflict.signals[0];
  return strongest ? SIGNAL_LABEL[strongest.kind] : null;
}

/** A person must decide: the model review escalated to a human. */
export function needsPerson(conflict: ConflictDetail) {
  return (
    conflict.state !== "resolved" && (conflict.review as ReviewWithModels).attention === "human"
  );
}

export function ConflictCard({
  conflict,
  headless = false,
}: {
  conflict: ConflictDetail;
  /** Inside a list row that already names the resource and state: skip the header. */
  headless?: boolean;
}) {
  const [left, right] = conflict.intents;
  const step = nextStep(conflict);
  const open = conflict.state !== "resolved";
  const strongest = conflict.signals[0];
  return (
    <article
      aria-label={`Semantic conflict on ${conflict.resource}`}
      className={
        open && !headless
          ? "grid gap-4 bg-kumo-elevated p-4 shadow-[inset_2px_0_0_var(--color-accent-500)]"
          : "grid gap-4 bg-kumo-elevated p-4"
      }
    >
      {!headless && (
        <header className="flex flex-wrap items-center gap-2">
          <Warning size={16} className={open ? "shrink-0 text-kumo-accent" : "shrink-0"} />
          <h3 className="text-[14px] font-extrabold">Semantic conflict</h3>
          <span className="font-mono text-[12px] break-all">{conflict.resource}</span>
          {strongest && <Tag variant="outline">{SIGNAL_LABEL[strongest.kind]}</Tag>}
          <StatusPill status={conflict.state} className="ml-auto" />
        </header>
      )}

      <div className="grid gap-3 min-[760px]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <IntentColumn intent={left} />
        <span className="self-center font-mono text-[11px] text-kumo-subtle">vs</span>
        <IntentColumn intent={right} />
      </div>

      <div className="grid gap-1">
        <h4 className="type-label text-kumo-subtle">Why the designs are incompatible</h4>
        <ul className="grid">
          {conflict.signals.map((signal) => (
            <li
              key={`${signal.kind}:${signal.detail}`}
              className="flex flex-wrap items-start gap-2 border-b border-kumo-rule py-1.5 text-[13px]"
            >
              <Tag variant={SEVERITY_TAG[signal.severity]}>{SIGNAL_LABEL[signal.kind]}</Tag>
              <span className="min-w-0 flex-1">{signal.detail}</span>
              <span className="font-mono text-[11px] text-kumo-subtle">{signal.severity}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid gap-1 text-[13px]">
        <p className="flex flex-wrap items-center gap-2">
          {conflict.recommendedAction === "fork_candidates" && <GitFork size={14} />}
          <span className="font-semibold">Next · {step.label}</span>
          <span className="text-kumo-subtle">{step.detail}</span>
        </p>
        {conflict.review.rationale && (
          <p className="text-[12px] text-kumo-subtle">{conflict.review.rationale}</p>
        )}
      </div>

      <Disclosure label="Details" className="border-t border-kumo-rule pt-1">
        <p className="font-mono text-[11px] break-all text-kumo-subtle">
          {conflict.id} · decided by {conflict.review.decidedBy}
          {conflict.challengeId ? ` · challenge ${conflict.challengeId}` : ""}
        </p>
        <ModelReviews review={conflict.review as ReviewWithModels} />
      </Disclosure>
    </article>
  );
}
ConflictCard.displayName = "ConflictCard";
