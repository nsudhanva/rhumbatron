import { Link } from "@tanstack/react-router";
import type {
  RequestConflictCriterion,
  RequestConflictDetail,
  RequestConflictSide,
} from "../../lib/api";
import { timeAgo } from "../../lib/format";
import { Mono } from "../ui/mono";
import { Tag } from "../ui/tag";
import { ChangeStatusWord } from "./change-status";

/**
 * Two requests whose acceptance criteria cannot both hold (expanded view of one row in the
 * conflict list). The system decides; this shows both requests, the cited criteria, and the
 * decision with its reason. No person overrides it here.
 */

/** The conflict read may carry the decision reason; older rows do not. */
type WithReason = RequestConflictDetail & { reason?: string | null };

function sideName(side: RequestConflictSide) {
  return side.requester.isYou ? "You" : (side.requester.name ?? "A collaborator");
}

/** Who decided, in words. `system:arbiter` is the automatic arbiter. */
function decidedByWords(decidedBy: string | null) {
  if (!decidedBy) return null;
  if (decidedBy === "system:arbiter") return "Decided automatically by the arbiter";
  if (decidedBy.startsWith("system:")) return `Decided automatically (${decidedBy.slice(7)})`;
  return `Decided by ${decidedBy}`;
}

/** One-line decision: which request goes ahead, or that none is chosen yet. */
function requestDecision(conflict: RequestConflictDetail) {
  const { a, b } = conflict;
  const winner =
    conflict.winnerChangeId === a.changeId ? a : conflict.winnerChangeId === b.changeId ? b : null;
  if (!winner) return "Not decided yet";
  return `"${winner.goal}" goes ahead`;
}

export function RequestConflictCard({
  conflict,
  currentChangeId,
  fallbackReason,
}: {
  conflict: RequestConflictDetail;
  currentChangeId: string;
  /** The current Change's recorded outcome reason, used when the conflict row has none. */
  fallbackReason?: string | null | undefined;
}) {
  const { a, b } = conflict;
  const criteria = (
    Array.isArray(conflict.criteria) ? conflict.criteria : []
  ) as RequestConflictCriterion[];
  const reason = (conflict as WithReason).reason ?? fallbackReason ?? null;
  const decided = decidedByWords(conflict.decidedBy);

  return (
    <article
      aria-label={`Conflicting requests between ${a.changeId} and ${b.changeId}`}
      className="grid gap-4 bg-kumo-elevated p-4"
    >
      <div className="grid gap-3 min-[760px]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <RequestSide
          side={a}
          isWinner={conflict.winnerChangeId === a.changeId}
          isCurrent={currentChangeId === a.changeId}
        />
        <span className="self-center font-mono text-[11px] text-kumo-subtle">vs</span>
        <RequestSide
          side={b}
          isWinner={conflict.winnerChangeId === b.changeId}
          isCurrent={currentChangeId === b.changeId}
        />
      </div>

      {criteria.length > 0 && (
        <div className="grid gap-1">
          <h4 className="type-label text-kumo-subtle">Criteria that cannot both hold</h4>
          <ul className="grid">
            {criteria.map((crit) => (
              <li
                key={`${crit.a}:${crit.b}`}
                className="grid gap-1.5 border-b border-kumo-rule py-2 text-[13px] last:border-b-0"
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="grid gap-0.5">
                    <span className="text-[11px] text-kumo-subtle">{sideName(a)} asked</span>
                    <span>{crit.aText ?? crit.a}</span>
                  </div>
                  <div className="grid gap-0.5">
                    <span className="text-[11px] text-kumo-subtle">{sideName(b)} asked</span>
                    <span>{crit.bText ?? crit.b}</span>
                  </div>
                </div>
                {crit.why && <p className="text-[12px] text-kumo-subtle">{crit.why}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <footer className="grid gap-0.5 border-t border-kumo-rule pt-2 text-[13px]">
        <p className="font-semibold">{requestDecision(conflict)}</p>
        {reason && <p className="text-pretty">{reason}</p>}
        {(decided || conflict.decidedAt) && (
          <p className="text-[12px] text-kumo-subtle">
            {decided}
            {conflict.decidedAt && (
              <>
                {decided ? " · " : ""}
                <time dateTime={conflict.decidedAt} title={conflict.decidedAt}>
                  {timeAgo(conflict.decidedAt)}
                </time>
              </>
            )}
          </p>
        )}
      </footer>
    </article>
  );
}
RequestConflictCard.displayName = "RequestConflictCard";

function RequestSide({
  side,
  isWinner,
  isCurrent,
}: {
  side: RequestConflictSide;
  isWinner: boolean;
  isCurrent: boolean;
}) {
  return (
    <div className="grid min-w-0 content-start gap-2 bg-kumo-base p-3">
      <div className="flex flex-wrap items-center gap-2">
        {isCurrent && <Tag variant="neutral">This change</Tag>}
        {isWinner && <Tag variant="outline">Goes ahead</Tag>}
        <ChangeStatusWord status={side.status} />
      </div>
      <div className="grid gap-1">
        {isCurrent ? (
          <span className="line-clamp-2 text-[14px] font-semibold">{side.goal}</span>
        ) : (
          <Link
            to="/changes/$changeId"
            params={{ changeId: side.changeId }}
            className="line-clamp-2 text-[14px] font-semibold hover:underline"
          >
            {side.goal}
          </Link>
        )}
        <p className="text-[12px] text-kumo-subtle">
          Requested by <span className="font-semibold text-kumo-default">{sideName(side)}</span>
        </p>
        <Mono subtle className="text-[11px]">
          {side.changeId}
        </Mono>
      </div>
    </div>
  );
}
RequestSide.displayName = "RequestSide";
