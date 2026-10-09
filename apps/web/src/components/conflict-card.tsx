import { Badge, LayerCard, Text } from "@cloudflare/kumo";
import { GitFork, Warning } from "@phosphor-icons/react";
import type { ConflictDetail, ConflictIntent, ConflictSignal } from "../lib/api";

/**
 * One semantic conflict between two Intents (AGENTS.md sections 32 and 38.2): the shared
 * resource, both designs side by side, the incompatible signals (hard first), and what happens
 * next. Git would merge both designs; this card shows why Rhumbatron does not.
 */

const STATE_VARIANT: Record<ConflictDetail["state"], "error" | "warning" | "success" | "info"> = {
  confirmed: "error",
  fork_required: "error",
  suspected: "warning",
  resolved: "success",
};

const SEVERITY_VARIANT: Record<ConflictSignal["severity"], "error" | "warning" | "secondary"> = {
  hard: "error",
  soft: "warning",
  benign: "secondary",
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
  return {
    label: "Needs review",
    detail:
      fork.reason === "needs_review"
        ? "The overlap is not decisive. A reviewer must confirm or dismiss it."
        : "No fork is needed.",
  };
}

function IntentColumn({ intent }: { intent: ConflictIntent }) {
  return (
    <div className="grid content-start gap-1.5 rounded-lg border border-kumo-line px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs text-kumo-subtle">
          {intent.taskKey || intent.taskId}
        </span>
        <Text bold>{intent.title || "Task"}</Text>
      </div>
      <Text>{intent.summary}</Text>
      {intent.assumptions.length > 0 && (
        <div className="grid gap-1">
          <Text as="h4" variant="secondary">
            Assumptions
          </Text>
          <ul className="list-disc pl-5 text-sm text-kumo-default">
            {intent.assumptions.map((item) => (
              <li key={item}>{item}</li>
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
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex flex-wrap items-center gap-2 px-5 py-2.5">
        <Warning size={18} weight="fill" className="shrink-0 text-kumo-danger" />
        <Text as="h2" variant="heading3">
          Semantic conflict
        </Text>
        <span className="font-mono text-xs text-kumo-default">{conflict.resource}</span>
        <Badge variant={STATE_VARIANT[conflict.state]}>{conflict.state}</Badge>
        <span className="ml-auto flex items-center gap-1.5">
          {conflict.recommendedAction === "fork_candidates" && <GitFork size={16} />}
          <Badge variant={conflict.forkDecision.kind === "fork" ? "info" : "warning"}>
            {step.label}
          </Badge>
        </span>
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-4 px-5 py-4">
        <div className="grid gap-3 min-[700px]:grid-cols-[1fr_auto_1fr]">
          <IntentColumn intent={left} />
          <span className="self-center justify-self-center text-sm text-kumo-subtle">vs</span>
          <IntentColumn intent={right} />
        </div>
        <div className="grid gap-1.5">
          <Text as="h3" bold>
            Why the designs are incompatible
          </Text>
          <ul className="grid gap-1.5">
            {conflict.signals.map((signal) => (
              <li
                key={`${signal.kind}:${signal.detail}`}
                className="flex flex-wrap items-start gap-2 text-sm"
              >
                <Badge variant={SEVERITY_VARIANT[signal.severity]}>
                  {SIGNAL_LABEL[signal.kind]}
                </Badge>
                <span className="min-w-0 flex-1 text-kumo-default">{signal.detail}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="grid gap-1">
          <Text variant="secondary">
            {step.label}: {step.detail}
          </Text>
          <Text variant="secondary">
            Decided by {conflict.review.decidedBy}
            {conflict.challengeId ? ` · Challenge ${conflict.challengeId}` : ""}
          </Text>
        </div>
      </LayerCard.Primary>
    </LayerCard>
  );
}
