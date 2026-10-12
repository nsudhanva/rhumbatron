import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { ConflictDetail } from "../../lib/api";
import type { CandidateView, ChangeView } from "../../lib/api-change";
import { truncate } from "../../lib/format";
import { gateRule } from "../candidate/model";
import { conflictLine, needsPerson } from "../conflict-card";
import { DeadLetters } from "../dead-letters";
import { SectionError } from "../project/feedback";
import { Section } from "../ui/page";
import { BudgetBlock } from "./change-budget";
import { ShipCandidate } from "./change-controls";
import { requesterName } from "./change-status";
import { ClarificationCard } from "./clarification-card";

/**
 * "Needs attention" (explain gates): only what waits on a person. Questions
 * to answer, an approval, a Candidate ready to ship (with the reason it waits and the Ship
 * action), a budget or merge block, a failed plan, a conflict the review sent to a person, or
 * commands that failed after retries. Renders nothing when nothing waits.
 */

/** The Candidate that waits for a human decision, if any. */
export function awaitingApproval(candidates: CandidateView[]) {
  return candidates.find(
    (c) =>
      c.status === "verified" && c.gate?.promotable === true && c.approvalRequired && !c.approval,
  );
}

/** Change statuses after which nothing ships from the Change. */
const NO_SHIP = new Set(["promoting", "releasing", "completed", "cancelled", "failed"]);
const IN_FLIGHT = new Set(["composing", "composed", "verifying"]);

/**
 * Verified Candidates a person can ship now: every required check passed, approved or no approval
 * needed, and no sibling (same base) still in flight (`selection_pending` in the API). A hint
 * only: the API and the integration Worker re-check every precondition.
 */
export function shippable(candidates: CandidateView[], changeStatus: string) {
  if (NO_SHIP.has(changeStatus)) return [];
  return candidates.filter(
    (c) =>
      c.status === "verified" &&
      c.gate?.promotable === true &&
      (!c.approvalRequired || c.approval?.decision === "granted") &&
      !candidates.some(
        (o) => o.id !== c.id && o.baseGeneration === c.baseGeneration && IN_FLIGHT.has(o.status),
      ),
  );
}

/** Why a verified Candidate waits for a person, in one line. */
function waitReason(candidate: CandidateView, riskTier: string | null | undefined) {
  if (candidate.approval?.decision === "granted") return "A person approved it.";
  return candidate.statusReason ?? gateRule(candidate, riskTier);
}

export function NeedsAttention({
  change,
  candidates,
  conflicts,
  candidateLabel,
  canAnswer,
  canRaiseBudget,
  canShip,
  hasOperatorIssues,
  review,
}: {
  change: ChangeView;
  candidates: CandidateView[];
  conflicts: ConflictDetail[];
  candidateLabel: (id: string) => string;
  canAnswer: boolean;
  /** Owner or admin: raise the request budget of a budget-blocked Change. */
  canRaiseBudget: boolean;
  /** Owner or admin: approve and ship a Candidate (`candidate.approve`, `candidate.promote`). */
  canShip: boolean;
  /** Include / Decline of a proposed request, for an owner or admin; null otherwise. */
  review: ReactNode;
  /** Dead letters or limit stops exist for this Change (the DeadLetters read). */
  hasOperatorIssues: boolean;
}) {
  const clarification = change.status === "needs_input" ? change.clarification : null;
  const approval = awaitingApproval(candidates);
  // A ready Candidate waits on a person once the Change is held for one, or after an approval.
  // A Candidate that auto-promotes is never listed here.
  const ready = shippable(candidates, change.status).filter(
    (c) => change.status === "awaiting_approval" || c.approval?.decision === "granted",
  );
  const humanConflicts = conflicts.filter(needsPerson);
  const planFailed =
    change.status === "failed" && (change.blockedReason?.startsWith("Planning failed:") ?? false);
  const blocked = change.status === "blocked" && change.blockedReason;
  // Every viewer sees which budget stopped the Change and who can raise it (change-budget.tsx).
  const budget = change.status === "budget_blocked";

  if (
    !review &&
    !clarification &&
    !approval &&
    ready.length === 0 &&
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
        {review && (
          <div className="grid gap-3 bg-kumo-warning-tint px-3.5 py-2.5 text-[13px] text-kumo-warning">
            <p>
              <span className="font-semibold">
                {requesterName(change) === "you" ? "You" : requesterName(change)} proposed this
                request.
              </span>{" "}
              Member requests wait for an owner or admin. Include starts the work; Decline ends it
              as not built.
            </p>
            <div className="text-kumo-default">{review}</div>
          </div>
        )}

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
            {waitReason(approval, change.riskTier)}{" "}
            {!canShip && "An owner or admin approves it, then ships it. "}
            <Link
              to="/candidates/$candidateId"
              params={{ candidateId: approval.id }}
              className="font-semibold underline"
            >
              {canShip ? "Review and approve" : "Review the evidence"}
            </Link>
          </p>
        )}

        {ready.map((c) => (
          <div
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 bg-kumo-warning-tint px-3.5 py-2.5 text-[13px] text-kumo-warning"
          >
            <p className="min-w-0 max-w-[760px] text-pretty">
              <span className="font-semibold">
                {candidateLabel(c.id)} passed every required check and is ready to ship.
              </span>{" "}
              {waitReason(c, change.riskTier)} {!canShip && "An owner or admin ships it. "}
              <Link
                to="/candidates/$candidateId"
                params={{ candidateId: c.id }}
                className="font-semibold underline"
              >
                Review the evidence
              </Link>
            </p>
            {canShip && (
              <div className="flex flex-wrap items-center gap-2 text-kumo-default">
                <ShipCandidate
                  changeId={change.id}
                  candidateId={c.id}
                  baseGeneration={c.baseGeneration}
                />
              </div>
            )}
          </div>
        ))}

        {budget && <BudgetBlock change={change} canRaiseBudget={canRaiseBudget} />}

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
