import { Link } from "@tanstack/react-router";
import type { ConflictDetail } from "../../lib/api";
import type { CandidateView, ChangeView } from "../../lib/api-change";
import { truncate } from "../../lib/format";
import { gateRule } from "../candidate/model";
import { conflictLine, needsPerson } from "../conflict-card";
import { DeadLetters } from "../dead-letters";
import { SectionError } from "../project/feedback";
import { Section } from "../ui/page";
import { RaiseBudget } from "./change-controls";
import { requesterName } from "./change-status";
import { ClarificationCard } from "./clarification-card";

/**
 * "Needs attention" (DESIGN.md 1.2, 12 "Explain gates"): only what waits on a person. Questions
 * to answer, an approval, a budget or merge block, a failed plan, a conflict the review sent to
 * a person, or commands that failed after retries. Renders nothing when nothing waits.
 */

/** The Candidate that waits for a human decision, if any. */
export function awaitingApproval(candidates: CandidateView[]) {
  return candidates.find(
    (c) =>
      c.status === "verified" && c.gate?.promotable === true && c.approvalRequired && !c.approval,
  );
}

export function NeedsAttention({
  change,
  candidates,
  conflicts,
  candidateLabel,
  canAnswer,
  hasOperatorIssues,
}: {
  change: ChangeView;
  candidates: CandidateView[];
  conflicts: ConflictDetail[];
  candidateLabel: (id: string) => string;
  canAnswer: boolean;
  /** Dead letters or limit stops exist for this Change (the DeadLetters read). */
  hasOperatorIssues: boolean;
}) {
  const clarification = change.status === "needs_input" ? change.clarification : null;
  const approval = awaitingApproval(candidates);
  const humanConflicts = conflicts.filter(needsPerson);
  const planFailed =
    change.status === "failed" && (change.blockedReason?.startsWith("Planning failed:") ?? false);
  const blocked = change.status === "blocked" && change.blockedReason;
  const budget = change.status === "budget_blocked";

  if (
    !clarification &&
    !approval &&
    humanConflicts.length === 0 &&
    !planFailed &&
    !blocked &&
    !budget &&
    !hasOperatorIssues
  ) {
    return null;
  }

  return (
    <Section label="Needs attention">
      <div className="grid gap-3">
        {clarification && (
          <ClarificationCard
            changeId={change.id}
            projectId={change.projectId}
            clarification={clarification}
            canAnswer={canAnswer}
            requester={requesterName(change)}
          />
        )}

        {approval && (
          <p className="bg-kumo-warning-tint px-3.5 py-2.5 text-[13px] text-kumo-warning">
            <span className="font-semibold">
              {candidateLabel(approval.id)} passed every required check and waits for approval.
            </span>{" "}
            {gateRule(approval, change.riskTier)}{" "}
            <Link
              to="/candidates/$candidateId"
              params={{ candidateId: approval.id }}
              className="font-semibold underline"
            >
              Review the evidence
            </Link>
          </p>
        )}

        {budget && <RaiseBudget changeId={change.id} budgetUsd={change.budgetUsd} />}

        {blocked && <SectionError message={change.blockedReason} />}

        {planFailed && change.blockedReason && (
          <SectionError message={change.blockedReason} className="whitespace-pre-wrap" />
        )}

        {humanConflicts.map((c) => (
          <p
            key={c.id}
            className="bg-kumo-warning-tint px-3.5 py-2.5 text-[13px] text-kumo-warning"
          >
            <span className="font-semibold">A design conflict needs a person:</span>{" "}
            {truncate(conflictLine(c), 160)}.{" "}
            <a href="#conflicts" className="font-semibold underline">
              See the conflict
            </a>
          </p>
        ))}

        <DeadLetters projectId={change.projectId} changeId={change.id} />
      </div>
    </Section>
  );
}
NeedsAttention.displayName = "NeedsAttention";
