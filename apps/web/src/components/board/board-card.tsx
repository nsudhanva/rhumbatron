import { cn } from "@cloudflare/kumo";
import { Link } from "@tanstack/react-router";
import type { BoardAgent, BoardCard as Card } from "../../lib/api-board";
import { changeLabel, formatAge, generation } from "../../lib/format";
import { ChangeStatusWord } from "../change/change-status";
import { TaskProgress } from "../project/status";
import { personName } from "./board-model";
import { ReviewActions } from "./review-actions";

/** Agent chips shown on a card before "+n more". */
const AGENT_CHIPS = 3;

const TIER_LETTER: Record<NonNullable<BoardAgent["tier"]>, string> = {
  haiku: "H",
  sonnet: "S",
  opus: "O",
};

const AGENT_STATE: Record<BoardAgent["state"], string> = {
  running: "Running",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
};

/**
 * One request on the Board (DESIGN.md 8.3 layer card, 10 "the whole row is the target"): the
 * title links to the Change and stretches over the card; Include and Decline sit above the link.
 * An owner or admin drags a Proposed card to Building to include it; the buttons do the same
 * from the keyboard.
 */
export function BoardCard({
  card,
  projectId,
  canReview,
  showRequester,
  onDragStart,
  onDragEnd,
}: {
  card: Card;
  projectId: string;
  canReview: boolean;
  /** "By stage" shows who asked; "By person" already names them in the lane. */
  showRequester: boolean;
  onDragStart: (changeId: string) => void;
  onDragEnd: () => void;
}) {
  const title = changeLabel(card);
  const reviewable = canReview && card.column === "proposed";
  const running = card.agents.filter((a) => a.state === "running").length;
  return (
    <article
      data-flip-id={card.changeId}
      data-testid="board-card"
      draggable={reviewable}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", card.changeId);
        onDragStart(card.changeId);
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "relative grid min-w-0 gap-2 bg-kumo-elevated p-3 transition-colors duration-(--rh-dur-ui) hover:bg-kumo-faint",
        reviewable && "cursor-grab active:cursor-grabbing",
      )}
    >
      <h3 className="line-clamp-2 text-[13px] leading-snug font-semibold" title={card.goal}>
        {/* Stretches over the card (the whole card is the target); the card drags, not the link. */}
        <Link
          to="/changes/$changeId"
          params={{ changeId: card.changeId }}
          draggable={false}
          className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-[-2px] focus-visible:after:outline-accent-500"
        >
          {title}
        </Link>
      </h3>
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] text-kumo-subtle">
        {showRequester && (
          <>
            <span className="truncate">{personName(card.requester)}</span>
            <span aria-hidden>·</span>
          </>
        )}
        <time dateTime={card.createdAt} title={card.createdAt} className="font-mono tabular-nums">
          {formatAge(card.createdAt)}
        </time>
        {card.generation !== null && (
          <>
            <span aria-hidden>·</span>
            <span className="font-mono tabular-nums">{generation(card.generation)}</span>
          </>
        )}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ChangeStatusWord status={card.status} />
        {card.tasks.total > 0 && (
          <span className="min-w-24 grow">
            <TaskProgress done={card.tasks.done} total={card.tasks.total} />
          </span>
        )}
      </div>
      {card.column === "not_built" && card.review.state === "declined" && (
        <p className="text-[12px] text-kumo-subtle">
          Declined
          {card.review.decidedBy?.name ? ` by ${card.review.decidedBy.name}` : ""}
          {card.review.reason ? `: ${card.review.reason}` : ""}
        </p>
      )}
      {card.agents.length > 0 && (
        <ul
          className="grid gap-1"
          aria-label={`${running} of ${card.agents.length} agents running`}
        >
          {card.agents.slice(0, AGENT_CHIPS).map((agent) => (
            <AgentChip key={agent.agentId} agent={agent} />
          ))}
          {card.agents.length > AGENT_CHIPS && (
            <li className="font-mono text-[11px] text-kumo-subtle">
              +{card.agents.length - AGENT_CHIPS} more
            </li>
          )}
        </ul>
      )}
      {reviewable && (
        <ReviewActions projectId={projectId} changeId={card.changeId} title={title} size="sm" />
      )}
    </article>
  );
}
BoardCard.displayName = "BoardCard";

/** An agent on the card: square dot (a live pulse while running), tier letter, Task title. */
function AgentChip({ agent }: { agent: BoardAgent }) {
  const tier = agent.tier ? TIER_LETTER[agent.tier] : "—";
  return (
    <li
      className="flex min-w-0 items-center gap-1.5 bg-kumo-base px-1.5 py-0.5 text-[11px]"
      title={`${agent.taskTitle} · ${agent.tier ?? "no model yet"} · ${AGENT_STATE[agent.state]}`}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0",
          agent.state === "running" && "animate-pulse bg-kumo-ink motion-reduce:animate-none",
          agent.state === "waiting" && "bg-kumo-warning",
          agent.state === "done" && "bg-kumo-success",
          agent.state === "failed" && "bg-accent-500",
        )}
      />
      <span className="w-3 shrink-0 font-mono font-semibold">{tier}</span>
      <span className="min-w-0 truncate">{agent.taskTitle}</span>
      <span className="sr-only">, {AGENT_STATE[agent.state]}</span>
    </li>
  );
}
AgentChip.displayName = "BoardAgentChip";
