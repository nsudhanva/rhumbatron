import { cn, Select } from "@cloudflare/kumo";
import { useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { BOARD_COLUMNS, type BoardColumn, getProjectBoard } from "../../lib/api-board";
import { formatNumber } from "../../lib/format";
import { useProjectLive } from "../../lib/live";
import { usePrefersReducedMotion } from "../../lib/motion";
import { ROLE_LABEL } from "../../lib/permissions";
import { SectionError, SkeletonBar } from "../project/feedback";
import { Tag } from "../ui/tag";
import { BoardCard } from "./board-card";
import {
  type BoardView,
  boardLanes,
  COLUMN_EMPTY,
  COLUMN_LABEL,
  columnCounts,
  type Lane,
  personName,
} from "./board-model";
import { useFlip } from "./use-flip";
import { boardKey, reviewKey, useReviewRequest } from "./use-review";

/** Safety net while the live socket is not open. */
const FALLBACK_POLL_MS = 10_000;
const EVERYONE = "everyone";
/** Columns keep their width and the board scrolls sideways inside its frame. */
const GRID = "grid grid-cols-[repeat(6,minmax(232px,1fr))] gap-px";

/**
 * The Board: every request of the Project as a card, by person (one lane each) or by stage
 * (one lane), across Proposed | Needs answer | Building | Checking | Shipped | Not built. Live
 * signals refresh it; without the socket it polls every 10 seconds.
 */
export function ProjectBoardView({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<BoardView>("person");
  const [person, setPerson] = useState<string | null>(null);
  const [socketOpen, setSocketOpen] = useState(false);
  const board = useQuery({
    queryKey: boardKey(projectId),
    queryFn: () => getProjectBoard({ data: projectId }),
    refetchInterval: socketOpen ? false : FALLBACK_POLL_MS,
  });
  const socket = useProjectLive(projectId, true, () => {
    void queryClient.invalidateQueries({ queryKey: boardKey(projectId) });
  });
  useEffect(() => setSocketOpen(socket === "open"), [socket]);

  const data = board.data;
  const lanes = useMemo(() => (data ? boardLanes(data, view, person) : []), [data, view, person]);
  const counts = useMemo(() => columnCounts(lanes), [lanes]);
  const layoutKey = useMemo(
    () =>
      `${view}|${lanes
        .map((l) =>
          BOARD_COLUMNS.map((c) => l.cells[c].map((card) => card.changeId).join()).join("/"),
        )
        .join("|")}`,
    [lanes, view],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const reduce = usePrefersReducedMotion();
  useFlip(scroller, layoutKey, reduce);

  // Drag a Proposed card onto any Building cell to include it (owner and admin).
  const { include } = useReviewRequest(projectId);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const canReview = data?.canReview === true;
  // A card leaves its column at once, so its own buttons are gone when the API refuses: the
  // Board reports the newest review that failed (and clears once a later one succeeds).
  const reviews = useMutationState({
    filters: { mutationKey: reviewKey(projectId) },
    select: (m) => ({
      at: m.state.submittedAt,
      status: m.state.status,
      message: m.state.error instanceof Error ? m.state.error.message : null,
      kind: m.options.mutationKey?.[2] === "decline" ? "declined" : "included",
    }),
  });
  const lastReview = reviews.reduce<(typeof reviews)[number] | undefined>(
    (latest, r) => (!latest || r.at >= latest.at ? r : latest),
    undefined,
  );

  const filterId = useId();
  const people = data?.people ?? [];

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="grid gap-1">
          <span aria-hidden className="type-label text-kumo-subtle">
            Group
          </span>
          <fieldset className="flex w-fit border border-kumo-divider">
            <legend className="sr-only">Board view</legend>
            {(
              [
                ["person", "By person"],
                ["stage", "By stage"],
              ] as const
            ).map(([value, label], index) => (
              <button
                key={value}
                type="button"
                aria-pressed={view === value}
                onClick={() => setView(value)}
                className={cn(
                  "flex h-8 items-center px-3 text-[13px] transition-colors duration-(--rh-dur-ui) focus-visible:outline-offset-[-2px] pointer-coarse:h-11",
                  index > 0 && "border-l border-kumo-divider",
                  view === value ? "bg-kumo-ink text-kumo-inverse" : "hover:bg-kumo-tint",
                )}
              >
                {label}
              </button>
            ))}
          </fieldset>
        </div>
        {people.length > 1 && (
          <div className="grid gap-1">
            <span id={filterId} className="type-label text-kumo-subtle">
              Person
            </span>
            <Select
              aria-labelledby={filterId}
              className="w-[200px]"
              value={person ?? EVERYONE}
              onValueChange={(v) => setPerson(typeof v === "string" && v !== EVERYONE ? v : null)}
              items={{
                [EVERYONE]: "Everyone",
                ...Object.fromEntries(people.map((p) => [p.userId, personName(p)])),
              }}
            />
          </div>
        )}
        {canReview && (
          <p className="pb-1.5 text-[12px] text-kumo-subtle">
            Drag a proposed request to Building, or use Include, to start it.
          </p>
        )}
      </div>

      {board.isError ? (
        <SectionError
          message={`The board could not load. ${board.error.message}`}
          onRetry={() => board.refetch()}
          retrying={board.isFetching}
        />
      ) : (
        <div
          ref={scroller}
          data-testid="board"
          className="relative min-w-0 overflow-x-auto border-y-2 border-kumo-divider"
        >
          <div className="min-w-[1420px]">
            <div className={cn(GRID, "bg-kumo-rule")}>
              {BOARD_COLUMNS.map((column) => (
                <h2
                  key={column}
                  className="flex items-baseline justify-between gap-2 bg-kumo-base px-3 py-2"
                >
                  <span className="type-h6">{COLUMN_LABEL[column]}</span>
                  <span className="font-mono text-[12px] text-kumo-subtle tabular-nums">
                    {data ? formatNumber(counts[column]) : ""}
                  </span>
                </h2>
              ))}
            </div>
            {!data ? (
              <div className={cn(GRID, "border-t border-kumo-rule bg-kumo-rule")} aria-busy="true">
                {BOARD_COLUMNS.map((column) => (
                  <div key={column} className="grid content-start gap-2 bg-kumo-base p-2">
                    <SkeletonBar height={64} className="w-full" />
                  </div>
                ))}
              </div>
            ) : lanes.length === 0 ? (
              <p className="px-3 py-4 text-[14px]">
                <span className="font-semibold">No requests yet.</span>{" "}
                <span className="text-kumo-subtle">
                  Describe a goal under New change on the Overview to start the first one.
                </span>
              </p>
            ) : (
              lanes.map((lane) => (
                <LaneRow
                  key={lane.key}
                  lane={lane}
                  projectId={projectId}
                  canReview={canReview}
                  showRequester={view === "stage"}
                  dragging={dragging}
                  over={over}
                  onOver={setOver}
                  onDragStart={setDragging}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  onDrop={(changeId) => {
                    setDragging(null);
                    setOver(null);
                    include.mutate(changeId);
                  }}
                />
              ))
            )}
          </div>
        </div>
      )}
      {lastReview?.status === "error" && (
        <SectionError
          message={`The request was not ${lastReview.kind}. ${lastReview.message ?? ""}`}
        />
      )}
    </div>
  );
}
ProjectBoardView.displayName = "ProjectBoardView";

function LaneRow({
  lane,
  projectId,
  canReview,
  showRequester,
  dragging,
  over,
  onOver,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  lane: Lane;
  projectId: string;
  canReview: boolean;
  showRequester: boolean;
  dragging: string | null;
  over: string | null;
  onOver: (key: string | null) => void;
  onDragStart: (changeId: string) => void;
  onDragEnd: () => void;
  onDrop: (changeId: string) => void;
}) {
  const p = lane.person;
  return (
    <section aria-label={p ? `Requests of ${personName(p)}` : "All requests"}>
      {p && (
        <header className="border-t-2 border-kumo-divider">
          {/* Sticks to the left edge while the columns scroll sideways. */}
          <div className="sticky left-0 flex w-fit max-w-[calc(100vw-32px)] flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <span
              aria-hidden
              className="grid size-7 shrink-0 place-items-center bg-tone-300 text-[11px] font-extrabold uppercase"
            >
              {(p.name ?? "?").trim().charAt(0) || "?"}
            </span>
            <span className="text-[14px] font-semibold">{personName(p)}</span>
            <Tag variant="neutral">{p.role ? ROLE_LABEL[p.role] : "Left the project"}</Tag>
            <span className="font-mono text-[12px] text-kumo-subtle tabular-nums">
              {formatNumber(p.counts.proposed)} proposed · {formatNumber(p.counts.active)} active ·{" "}
              {formatNumber(p.counts.shipped)} shipped · {formatNumber(p.counts.notBuilt)} not built
            </span>
          </div>
        </header>
      )}
      <div className={cn(GRID, "border-t border-kumo-rule bg-kumo-rule")}>
        {BOARD_COLUMNS.map((column) => (
          <Cell
            key={column}
            laneKey={lane.key}
            column={column}
            lane={lane}
            projectId={projectId}
            canReview={canReview}
            showRequester={showRequester}
            dragging={dragging}
            over={over}
            onOver={onOver}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDrop={onDrop}
          />
        ))}
      </div>
    </section>
  );
}
LaneRow.displayName = "BoardLane";

function Cell({
  laneKey,
  column,
  lane,
  projectId,
  canReview,
  showRequester,
  dragging,
  over,
  onOver,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  laneKey: string;
  column: BoardColumn;
  lane: Lane;
  projectId: string;
  canReview: boolean;
  showRequester: boolean;
  dragging: string | null;
  over: string | null;
  onOver: (key: string | null) => void;
  onDragStart: (changeId: string) => void;
  onDragEnd: () => void;
  onDrop: (changeId: string) => void;
}) {
  const cards = lane.cells[column];
  const key = `${laneKey}:${column}`;
  const target = canReview && column === "building" && dragging !== null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop zone; Include is the keyboard path
    <div
      data-column={column}
      className={cn(
        "grid min-h-24 content-start gap-2 bg-kumo-base p-2 transition-colors duration-(--rh-dur-ui)",
        target && "bg-kumo-tint",
        target && over === key && "outline-2 outline-offset-[-2px] outline-accent-500",
      )}
      onDragOver={(event) => {
        if (!target) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (over !== key) onOver(key);
      }}
      onDragLeave={() => over === key && onOver(null)}
      onDrop={(event) => {
        if (!target) return;
        event.preventDefault();
        const changeId = event.dataTransfer.getData("text/plain") || dragging;
        if (changeId) onDrop(changeId);
      }}
    >
      {cards.length === 0 ? (
        lane.person ? (
          <span className="px-1 text-[12px] text-kumo-subtle">—</span>
        ) : (
          <p className="px-1 text-[12px] text-kumo-subtle">{COLUMN_EMPTY[column]}</p>
        )
      ) : (
        cards.map((card) => (
          <BoardCard
            key={card.changeId}
            card={card}
            projectId={projectId}
            canReview={canReview}
            showRequester={showRequester}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))
      )}
    </div>
  );
}
Cell.displayName = "BoardCell";
