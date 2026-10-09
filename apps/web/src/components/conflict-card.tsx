import { GitFork, Warning } from "@phosphor-icons/react";
import type { ConflictDetail, ConflictIntent, ConflictSignal } from "../lib/api";
import { StatusPill } from "./ui/status-pill";
import { Tag, type TagVariant } from "./ui/tag";

/**
 * One semantic conflict between two Intents (AGENTS.md sections 32 and 38.2): the shared
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

export function ConflictCard({ conflict }: { conflict: ConflictDetail }) {
  const [left, right] = conflict.intents;
  const step = nextStep(conflict);
  const open = conflict.state !== "resolved";
  const strongest = conflict.signals[0];
  return (
    <article
      aria-label={`Semantic conflict on ${conflict.resource}`}
      className={
        open
          ? "grid gap-4 bg-kumo-elevated p-4 shadow-[inset_2px_0_0_var(--color-accent-500)]"
          : "grid gap-4 bg-kumo-elevated p-4"
      }
    >
      <header className="flex flex-wrap items-center gap-2">
        <Warning size={16} className={open ? "shrink-0 text-kumo-accent" : "shrink-0"} />
        <h3 className="text-[14px] font-extrabold">Semantic conflict</h3>
        <span className="font-mono text-[12px] break-all">{conflict.resource}</span>
        {strongest && <Tag variant="outline">{SIGNAL_LABEL[strongest.kind]}</Tag>}
        <StatusPill status={conflict.state} className="ml-auto" />
      </header>

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
          <span className="font-semibold">Recommended · {step.label}</span>
          <span className="text-kumo-subtle">{step.detail}</span>
        </p>
        <p className="font-mono text-[11px] text-kumo-subtle">
          decided by {conflict.review.decidedBy}
          {conflict.challengeId ? ` · challenge ${conflict.challengeId}` : ""}
        </p>
        {conflict.review.rationale && (
          <p className="text-[12px] text-kumo-subtle">{conflict.review.rationale}</p>
        )}
      </div>
    </article>
  );
}
