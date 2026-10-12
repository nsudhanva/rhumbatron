import { Button, cn } from "@cloudflare/kumo";
import { ArrowCounterClockwise, Pause, Play, Warning } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { formatClock, formatDuration, formatNumber, generation, truncate } from "../../lib/format";
import { renderNow } from "../../lib/render-time";
import { Loader } from "../ui/loader";
import { SegmentedSteps } from "../ui/meter";
import { Mono } from "../ui/mono";
import { type StatusFamily, StatusPill, statusView } from "../ui/status-pill";
import { Tag } from "../ui/tag";
import { previewActivityInput } from "./activity-fixture";
import {
  type ActivityEvent,
  type ActivityModel,
  type ActivityView,
  CALLS_PER_RUN,
  type CandidateSpec,
  type CandidateView,
  type ConflictView,
  deriveActivity,
  foldActivity,
  type LaneSpec,
  type LaneView,
} from "./activity-model";
import { type ActivityPlayer, useActivityPlayer } from "./use-activity-player";

/**
 * Agent activity: the one place motion leads.
 *
 * A git-style graph. The canonical trunk runs down the left gutter from the base generation.
 * Each Task's agent is a lane that forks from the trunk when it wakes. Typed messages travel
 * along the Workspace bus in the right rail: Intents up to the Workspace, a Challenge from one
 * lane to another (then an accent connector holds while the conflict is open), ChangeSets down
 * into the Candidates they compose. Candidates fork, fill their checks as Evidence lands, the
 * loser greys out with its reason, and the winner merges back so the generation ticks over.
 *
 * Every mark is a recorded fact (see activity-model.ts). Facts that arrive while the page is
 * open play at `--rh-agent-cadence`; Replay re-plays them all from the base generation.
 */

/* Geometry, in px. Fixed row heights let the overlays compute every path without measuring. */
const GUTTER = 64;
const RAIL = 208;
const TRUNK_X = 18;
const DOT_X = 46;
const DOT = 8;
const BUS_X = 16;
const HEAD_H = 48;
const LANE_H = 56;
const SUB_H = 32;
const CAND_H = 64;
const END_H = 56;
const MIN_WIDTH = 920;

/* Activity-local motion: a connector that waits for its packet, then draws. Uses theme tokens
   only; candidates to move into theme.css as `rh-connector`. */
const AFTER_PACKET: CSSProperties = {
  animationDelay: "var(--rh-dur-packet)",
  animationDuration: "var(--rh-dur-fork)",
};

const FAMILY_STROKE_FILL: Record<StatusFamily, string> = {
  ok: "fill-kumo-success",
  attention: "fill-kumo-warning",
  danger: "fill-accent-500",
  active: "fill-kumo-ink",
  idle: "fill-tone-300",
};

const TYPE_TEXT = (event: ActivityEvent) => {
  // A failure a later attempt recovered (or is retrying) is attention, not danger (lib/recovery).
  if (event.outcome && event.outcome !== "failed") return "text-kumo-warning";
  if (event.kind === "run.end" && event.status === "failed") return "text-kumo-danger";
  if (event.kind === "check" && (event.status === "fail" || event.status === "error"))
    return "text-kumo-danger";
  if (event.kind === "candidate.status" && event.status === "rejected") return "text-kumo-danger";
  if (event.kind === "challenge") return "text-kumo-danger";
  if (event.kind === "claim" && event.action === "contended") return "text-kumo-warning";
  if (event.kind === "promoted") return "text-kumo-accent";
  if (event.kind === "fact") {
    const t = event.eventType;
    if (t.endsWith(".failed") || t === "candidate.stale" || t.endsWith(".rejected"))
      return "text-kumo-danger";
    if (t === "canonical.advanced" || t === "artifact.promoted") return "text-kumo-accent";
    if (t.endsWith(".completed")) return "text-kumo-success";
  }
  if (
    event.kind === "run.end" ||
    (event.kind === "candidate.status" && event.status === "verified")
  )
    return "text-kumo-success";
  return "text-kumo-default";
};

function layout(lanes: number, candidates: number) {
  const laneMid = (i: number) => HEAD_H + i * LANE_H + LANE_H / 2;
  const candTop = HEAD_H + lanes * LANE_H + (candidates > 0 ? SUB_H : 0);
  const candMid = (j: number) => candTop + j * CAND_H + CAND_H / 2;
  const endTop = candTop + candidates * CAND_H;
  return {
    headMid: HEAD_H / 2,
    laneMid,
    candMid,
    endMid: endTop + END_H / 2,
    busEnd: candidates > 0 ? candMid(candidates - 1) : lanes > 0 ? laneMid(lanes - 1) : HEAD_H,
    height: endTop + END_H,
  };
}
type Geometry = ReturnType<typeof layout>;

/** Wall-clock "now" that ticks once a second while `enabled`. */
function useNow(enabled: boolean) {
  // The request instant while hydrating (lib/render-time.ts), so elapsed text matches the server.
  const [now, setNow] = useState(renderNow);
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

export function AgentActivity({
  model,
  ready,
  compiling = false,
  linkCandidates = true,
  className,
}: {
  model: ActivityModel;
  /** True once every source has loaded once. Until then the view settles without motion. */
  ready: boolean;
  /** The Root Planner is still compiling the Work Graph. */
  compiling?: boolean;
  /** Candidate names link to their page. Off in the fixture preview. */
  linkCandidates?: boolean;
  className?: string;
}) {
  const headingId = useId();
  const player = useActivityPlayer(model.events, ready);
  const complete = model.events.every((e) => player.played.has(e.id));
  const view = useMemo(
    () => foldActivity(model, player.played, complete),
    [model, player.played, complete],
  );
  const geo = useMemo(
    () => layout(model.lanes.length, model.candidates.length),
    [model.lanes.length, model.candidates.length],
  );
  const running = complete && model.lanes.some((l) => l.runningSince !== null);
  const now = useNow(running);

  const woken = model.lanes.filter((l) => view.lanes[l.id]?.forked).length;
  const active = model.lanes.filter((l) => view.lanes[l.id]?.status === "running").length;
  const open = view.conflicts.filter((c) => c.open).length;
  const forkedCandidates = model.candidates.filter((c) => view.candidates[c.id]?.forked).length;

  return (
    <section
      aria-labelledby={headingId}
      className={cn("grid min-w-0 rule-ink bg-kumo-elevated", className)}
    >
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-kumo-rule px-4 pt-3 pb-2.5">
        <div className="grid min-w-0 gap-1">
          <h2 id={headingId} className="type-h6">
            Agent activity
          </h2>
          <p className="text-[12px] text-kumo-subtle">
            {formatNumber(woken)} of {formatNumber(model.lanes.length)} agents woken ·{" "}
            {formatNumber(active)} running · {formatNumber(open)} open{" "}
            {open === 1 ? "conflict" : "conflicts"} · {formatNumber(forkedCandidates)}{" "}
            {forkedCandidates === 1 ? "Candidate" : "Candidates"}
          </p>
        </div>
        <PlayerControls player={player} total={model.events.length} />
      </header>

      <div className="grid min-w-0 min-[1500px]:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 overflow-x-auto">
          {compiling && model.lanes.length === 0 ? (
            <p className="flex items-center gap-2 px-4 py-6 text-[13px]">
              <Loader /> Root Planner is compiling the Work Graph. Lanes appear when Tasks exist.
            </p>
          ) : (
            <Graph
              model={model}
              view={view}
              geo={geo}
              player={player}
              now={now}
              complete={complete}
              linkCandidates={linkCandidates}
            />
          )}
        </div>
        <EventList
          model={model}
          player={player}
          className="border-t border-kumo-rule min-[1500px]:border-t-0 min-[1500px]:border-l"
          maxHeight={Math.max(240, geo.height)}
        />
      </div>

      <Disputes model={model} conflicts={view.conflicts.filter((c) => c.open)} />
      <Convergence model={model} view={view} />

      {/* One polite announcement per played fact. Silent while paused. */}
      <p className="sr-only" aria-live={player.paused ? "off" : "polite"} aria-atomic>
        {player.paused ? "" : (player.latest?.detail ?? "")}
      </p>
    </section>
  );
}
AgentActivity.displayName = "AgentActivity";

function PlayerControls({ player, total }: { player: ActivityPlayer; total: number }) {
  const state = player.paused
    ? `Paused · ${formatNumber(player.waiting)} new`
    : player.replaying
      ? `Replaying ${formatNumber(player.played.size)} / ${formatNumber(total)}`
      : player.waiting > 0
        ? `Playing · ${formatNumber(player.waiting)} queued`
        : `Up to date · ${formatNumber(total)} ${total === 1 ? "event" : "events"}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">{state}</span>
      <Button
        size="sm"
        variant="secondary"
        icon={player.paused ? Play : Pause}
        onClick={player.paused ? player.resume : player.pause}
      >
        {player.paused ? "Resume" : "Pause"}
      </Button>
      {total > 0 && (
        <Button size="sm" variant="secondary" icon={ArrowCounterClockwise} onClick={player.replay}>
          Replay
        </Button>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------------------------
 * Graph
 * ------------------------------------------------------------------------------------------ */

function Graph({
  model,
  view,
  geo,
  player,
  now,
  complete,
  linkCandidates,
}: {
  model: ActivityModel;
  view: ActivityView;
  geo: Geometry;
  player: ActivityPlayer;
  now: number;
  complete: boolean;
  linkCandidates: boolean;
}) {
  const promotedGeneration = view.promoted?.generation;
  return (
    <div className="relative" style={{ minWidth: MIN_WIDTH, height: geo.height }}>
      <Row height={HEAD_H}>
        <div className="flex h-full items-center gap-3 border-b border-kumo-rule">
          <Mono className="text-[13px] font-semibold">{generation(model.baseGeneration)}</Mono>
          <span className="text-[12px] text-kumo-subtle">
            Canonical base. Every lane forks from here.
          </span>
        </div>
        <div className="relative flex h-full items-center border-b border-kumo-rule pl-7">
          {view.workspaceArrival && (
            <Flash
              key={view.workspaceArrival}
              delayed={player.inFlight.has(view.workspaceArrival)}
            />
          )}
          <span className="relative type-label text-kumo-subtle">Workspace · typed state</span>
        </div>
      </Row>

      <ol aria-label="Agent lanes">
        {model.lanes.map((lane) => {
          const state = view.lanes[lane.id];
          if (!state) return null;
          return (
            <li key={lane.id}>
              <Row height={LANE_H}>
                <Lane
                  lane={lane}
                  state={state}
                  current={view.current === lane.id}
                  arrivalInFlight={state.arrival !== null && player.inFlight.has(state.arrival)}
                  now={complete ? now : null}
                />
                <div className="h-full border-b border-kumo-rule" />
              </Row>
            </li>
          );
        })}
      </ol>

      {model.candidates.length > 0 && (
        <Row height={SUB_H}>
          <div className="flex h-full items-end gap-3 border-b border-kumo-divider pb-1.5">
            <span className="type-label text-kumo-subtle">Candidates</span>
            <span className="truncate text-[12px] text-kumo-subtle">
              Possible futures composed from ChangeSets. Executable evidence decides.
            </span>
          </div>
          <div className="h-full border-b border-kumo-divider" />
        </Row>
      )}

      <ol aria-label="Candidates">
        {model.candidates.map((spec) => {
          const state = view.candidates[spec.id];
          if (!state) return null;
          return (
            <li key={spec.id}>
              <Row height={CAND_H}>
                <CandidateRow
                  spec={spec}
                  state={state}
                  current={view.current === spec.id}
                  animate={player.animated.has(`${spec.id}:fork`)}
                  arrivalInFlight={state.arrival !== null && player.inFlight.has(state.arrival)}
                  link={linkCandidates}
                />
                <div className="h-full border-b border-kumo-rule" />
              </Row>
            </li>
          );
        })}
      </ol>

      <Row height={END_H}>
        <div className="relative flex h-full items-center gap-3">
          {view.promoted && (
            <Flash
              key={view.promoted.eventId}
              delayed={player.inFlight.has(view.promoted.eventId)}
            />
          )}
          {promotedGeneration !== undefined ? (
            <>
              <Mono className="relative text-[13px] font-semibold text-kumo-accent">
                {generation(model.baseGeneration)} → {generation(promotedGeneration)}
              </Mono>
              <span className="relative text-[12px] text-kumo-subtle">
                Canonical advanced. One verified future merged.
              </span>
            </>
          ) : (
            <>
              <Mono className="text-[13px] font-semibold">{generation(model.baseGeneration)}</Mono>
              <span className="text-[12px] text-kumo-subtle">
                Not promoted yet. Canonical stays at {generation(model.baseGeneration)} until a
                verified Candidate merges.
              </span>
            </>
          )}
        </div>
        <div />
      </Row>

      <Gutter model={model} view={view} geo={geo} player={player} />
      <Rail model={model} view={view} geo={geo} player={player} />
    </div>
  );
}

function Row({ height, children }: { height: number; children: [ReactNode, ReactNode] }) {
  return (
    <div
      className="grid"
      style={{ height, gridTemplateColumns: `${GUTTER}px minmax(0,1fr) ${RAIL}px` }}
    >
      <div aria-hidden />
      {children[0]}
      {children[1]}
    </div>
  );
}

/** One faint fill on arrival. Waits for the packet when one is still travelling. */
function Flash({ delayed }: { delayed: boolean }) {
  return (
    <span
      aria-hidden
      className="rh-arrive pointer-events-none absolute inset-0"
      style={delayed ? { animationDelay: "var(--rh-dur-packet)" } : undefined}
    />
  );
}

function Lane({
  lane,
  state,
  current,
  arrivalInFlight,
  now,
}: {
  lane: LaneSpec;
  state: LaneView;
  current: boolean;
  arrivalInFlight: boolean;
  now: number | null;
}) {
  const cap = state.tier ? CALLS_PER_RUN[state.tier] : null;
  const progress = state.calls !== null && cap ? Math.min(1, state.calls / cap) : 0;
  const elapsed =
    now !== null && state.status === "running" && lane.runningSince !== null
      ? `running ${formatDuration(Math.max(0, (now - lane.runningSince) / 1000))}`
      : null;
  const second =
    state.calls !== null && cap
      ? `${formatNumber(state.calls)} / ${formatNumber(cap)} calls`
      : (elapsed ?? (state.forked ? `attempt ${state.attempt}` : "not woken"));
  return (
    <div
      className={cn(
        "relative grid h-full grid-cols-[minmax(150px,210px)_116px_minmax(0,1fr)_84px] items-center gap-3 border-b border-kumo-rule pr-3 pl-3",
        current && "shadow-[inset_2px_0_0_var(--color-accent-500)]",
        !state.forked && "text-kumo-subtle",
      )}
    >
      {state.arrival && <Flash key={state.arrival} delayed={arrivalInFlight} />}
      <div className="relative grid min-w-0">
        <span className="truncate font-mono text-[10px] tracking-[0.06em] text-kumo-subtle uppercase">
          {lane.key} · {lane.kind}
          {state.claims.length > 0 && (
            <span title={`Claims: ${state.claims.join(", ")}`} className="text-kumo-default">
              {" "}
              · {state.claims.length === 1 ? "1 claim" : `${state.claims.length} claims`}
            </span>
          )}
        </span>
        <span className="truncate text-[13px] font-semibold" title={lane.title}>
          {lane.title}
        </span>
      </div>
      <div className="relative grid min-w-0 justify-items-start gap-0.5">
        {state.tier ? <Tag className="py-px font-mono">{state.tier}</Tag> : <span>—</span>}
        <span className="truncate font-mono text-[11px] text-kumo-subtle tabular-nums">
          {second}
        </span>
      </div>
      <p
        className={cn("relative truncate text-[13px]", current && "font-semibold")}
        title={state.step}
      >
        {state.step}
      </p>
      <StatusPill status={state.status} className="relative justify-self-end" />
      {state.forked && (
        <div aria-hidden className="absolute right-0 bottom-0 left-0 h-0.5 bg-kumo-faint">
          <div className="rh-lane-progress" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </div>
  );
}

function checkStatus(state: CandidateView, checkId: string) {
  const result = state.checks[checkId];
  if (!result) return "queued";
  return result.coverage === "not_checked" ? "not_checked" : result.status;
}

function CandidateRow({
  spec,
  state,
  current,
  animate,
  arrivalInFlight,
  link,
}: {
  spec: CandidateSpec;
  state: CandidateView;
  current: boolean;
  animate: boolean;
  arrivalInFlight: boolean;
  link: boolean;
}) {
  const name = spec.name;
  if (!state.forked) {
    return <div aria-hidden className="h-full border-b border-kumo-rule" />;
  }
  const rejected = state.status === "rejected" || state.status === "stale";
  const steps = spec.checks.map((c) => ({
    label: c.checkId,
    status: checkStatus(state, c.checkId),
  }));
  return (
    <div
      data-state={rejected ? "rejected" : undefined}
      className={cn(
        "rh-greyout relative grid h-full grid-cols-[minmax(150px,210px)_minmax(0,1fr)_84px] items-center gap-3 border-b border-kumo-rule pr-3 pl-3",
        animate && "rh-settle",
        current && "shadow-[inset_2px_0_0_var(--color-accent-500)]",
      )}
    >
      {state.arrival && <Flash key={state.arrival} delayed={arrivalInFlight} />}
      <div className="relative grid min-w-0">
        <span className="truncate text-[13px] font-semibold">
          {link ? (
            <Link
              to="/candidates/$candidateId"
              params={{ candidateId: spec.id }}
              className="hover:underline"
            >
              {name}
            </Link>
          ) : (
            name
          )}
        </span>
        <span
          className="truncate font-mono text-[11px] text-kumo-subtle tabular-nums"
          title={spec.id}
        >
          {spec.id} · {formatNumber(state.changeSets)}{" "}
          {state.changeSets === 1 ? "ChangeSet" : "ChangeSets"}
        </span>
      </div>
      <div className="relative grid min-w-0 gap-1">
        {steps.length > 0 ? (
          <SegmentedSteps steps={steps} label={`${name} checks`} />
        ) : (
          <span className="text-[12px] text-kumo-subtle">Verification plan not built yet.</span>
        )}
        <CandidateLine state={state} />
      </div>
      <StatusPill status={state.status} className="relative justify-self-end" />
    </div>
  );
}

function CandidateLine({ state }: { state: CandidateView }) {
  if (state.status === "rejected") {
    return (
      <p className="truncate text-[12px] text-kumo-danger" title={state.reason ?? undefined}>
        <span className="font-semibold">Rejected</span>
        {state.reason ? ` · ${state.reason}` : " · no reason recorded"}
      </p>
    );
  }
  if (state.status === "promoted") {
    return <p className="truncate text-[12px] text-kumo-accent">Merged into the trunk.</p>;
  }
  if (state.approval) {
    return (
      <p className="truncate text-[12px]">
        {state.approval === "granted" ? "Approved by a person." : "Rejected by a person."}
      </p>
    );
  }
  if (state.status === "verified") {
    return <p className="truncate text-[12px] text-kumo-success">Every required check passed.</p>;
  }
  if (state.status === "stale") {
    return (
      <p className="truncate text-[12px] text-kumo-warning">Canonical moved. Recompose to retry.</p>
    );
  }
  return null;
}

/* --------------------------------------------------------------------------------------------
 * Overlays
 * ------------------------------------------------------------------------------------------ */

const forkPath = (y: number, top: number) =>
  `M ${TRUNK_X} ${Math.max(top, y - 22)} C ${TRUNK_X} ${y - 4}, ${TRUNK_X + 8} ${y}, ${DOT_X - DOT / 2} ${y}`;

/** The winner leaves its dot and curves down into the trunk at the next generation. */
const mergePath = (y: number, end: number) =>
  `M ${DOT_X - DOT / 2} ${y} C ${TRUNK_X + 4} ${y}, ${TRUNK_X} ${y + 12}, ${TRUNK_X} ${Math.min(end, y + 28)} V ${end}`;

function Gutter({
  model,
  view,
  geo,
  player,
}: {
  model: ActivityModel;
  view: ActivityView;
  geo: Geometry;
  player: ActivityPlayer;
}) {
  const promotedIndex = view.promoted
    ? model.candidates.findIndex((c) => c.id === view.promoted?.candidateId)
    : -1;
  return (
    <svg
      aria-hidden
      width={GUTTER}
      height={geo.height}
      className="pointer-events-none absolute top-0 left-0"
    >
      <path
        d={`M ${TRUNK_X} ${geo.headMid} V ${geo.endMid}`}
        className="stroke-kumo-ink"
        strokeWidth={2}
        fill="none"
      />
      <rect x={TRUNK_X - 5} y={geo.headMid - 5} width={10} height={10} className="fill-kumo-ink" />

      {model.lanes.map((lane, i) => {
        const state = view.lanes[lane.id];
        if (!state) return null;
        const y = geo.laneMid(i);
        const family = statusView(state.status).family;
        return (
          <g key={lane.id}>
            {state.forked ? (
              <path
                key={player.animated.has(`${lane.id}:fork`) ? "animated" : "settled"}
                d={forkPath(y, geo.headMid)}
                pathLength={1}
                className={cn(
                  "stroke-kumo-ink",
                  player.animated.has(`${lane.id}:fork`) && "rh-fork",
                )}
                strokeWidth={2}
                fill="none"
              />
            ) : (
              <path
                d={`M ${TRUNK_X} ${y} H ${DOT_X - DOT / 2}`}
                className="stroke-kumo-divider"
                strokeWidth={1}
                strokeDasharray="2 3"
                fill="none"
              />
            )}
            <rect
              x={DOT_X - DOT / 2}
              y={y - DOT / 2}
              width={DOT}
              height={DOT}
              className={FAMILY_STROKE_FILL[family]}
            />
          </g>
        );
      })}

      {model.candidates.map((spec, j) => {
        const state = view.candidates[spec.id];
        if (!state?.forked) return null;
        const y = geo.candMid(j);
        const winning = state.status === "verified" || state.status === "promoted";
        const losing = state.status === "rejected" || state.status === "stale";
        const animated = player.animated.has(`${spec.id}:fork`);
        return (
          <g key={spec.id}>
            <path
              d={forkPath(y, geo.headMid)}
              pathLength={1}
              className={cn(
                winning ? "stroke-accent-500" : losing ? "stroke-kumo-divider" : "stroke-kumo-ink",
                animated && "rh-fork",
              )}
              strokeWidth={2}
              fill="none"
            />
            <rect
              x={DOT_X - DOT / 2}
              y={y - DOT / 2}
              width={DOT}
              height={DOT}
              // The loser greys out; red stays with the conflict and the winning path.
              className={
                losing ? "fill-tone-400" : FAMILY_STROKE_FILL[statusView(state.status).family]
              }
            />
          </g>
        );
      })}

      {view.promoted && promotedIndex >= 0 && (
        <path
          key={view.promoted.eventId}
          d={mergePath(geo.candMid(promotedIndex), geo.endMid)}
          pathLength={1}
          className={cn(
            "stroke-accent-500",
            player.animated.has(view.promoted.eventId) && "rh-merge",
          )}
          strokeWidth={2}
          fill="none"
        />
      )}

      <rect
        x={TRUNK_X - 5}
        y={geo.endMid - 5}
        width={10}
        height={10}
        strokeWidth={2}
        className={
          view.promoted ? "fill-accent-500 stroke-accent-500" : "fill-none stroke-kumo-ink"
        }
      />
    </svg>
  );
}

const CONNECTOR_X = 52;
const CONNECTOR_STEP = 12;

function Rail({
  model,
  view,
  geo,
  player,
}: {
  model: ActivityModel;
  view: ActivityView;
  geo: Geometry;
  player: ActivityPlayer;
}) {
  const laneIndex = new Map(model.lanes.map((l, i) => [l.id, i]));
  const candIndex = new Map(model.candidates.map((c, j) => [c.id, j]));
  const laneY = (id: string) => {
    const i = laneIndex.get(id);
    return i === undefined ? null : geo.laneMid(i);
  };

  const packets: { id: string; d: string; label: string; accent: boolean }[] = [];
  for (const event of model.events) {
    if (!player.inFlight.has(event.id)) continue;
    if (event.kind === "intent") {
      const y = laneY(event.laneId);
      if (y !== null)
        packets.push({
          id: event.id,
          d: `M 0 ${y} H ${BUS_X} V ${geo.headMid}`,
          label: "Intent",
          accent: false,
        });
    } else if (event.kind === "claim" && event.action === "acquired" && event.laneId) {
      const y = laneY(event.laneId);
      if (y !== null)
        packets.push({
          id: event.id,
          d: `M 0 ${y} H ${BUS_X} V ${geo.headMid}`,
          label: "Claim",
          accent: false,
        });
    } else if (
      event.kind === "claim" &&
      event.action === "contended" &&
      event.laneId &&
      event.holderLaneId
    ) {
      const a = laneY(event.laneId);
      const b = laneY(event.holderLaneId);
      if (a !== null && b !== null)
        packets.push({
          id: event.id,
          d: `M 0 ${a} H ${CONNECTOR_X} V ${b} H 0`,
          label: `Contended · ${event.resource}`,
          accent: false,
        });
    } else if (event.kind === "changeset") {
      const y = laneY(event.laneId);
      const j = candIndex.get(event.candidateId);
      if (y !== null && j !== undefined)
        packets.push({
          id: event.id,
          d: `M 0 ${y} H ${BUS_X} V ${geo.candMid(j)} H 0`,
          label: "ChangeSet",
          accent: false,
        });
    } else if (event.kind === "challenge" && event.challenged) {
      const a = laneY(event.fromLaneId);
      const b = laneY(event.toLaneId);
      if (a !== null && b !== null)
        packets.push({
          id: event.id,
          d: `M 0 ${a} H ${CONNECTOR_X} V ${b} H 0`,
          label: "Challenge",
          accent: true,
        });
    }
  }

  const connectors = view.conflicts
    .filter((c) => c.open)
    .map((conflict, k) => {
      const a = laneY(conflict.fromLaneId);
      const b = laneY(conflict.toLaneId);
      if (a === null || b === null) return null;
      return { conflict, a, b, x: CONNECTOR_X + Math.min(k, 4) * CONNECTOR_STEP };
    })
    .filter((c): c is { conflict: ConflictView; a: number; b: number; x: number } => c !== null);

  // Historical contention markers, one per recorded pair and resource. These are facts,
  // not open conflicts or locks. A holder outside this Change has no invented lane.
  const contentions = new Map<
    string,
    { event: Extract<ActivityEvent, { kind: "claim" }>; a: number; b: number | null }
  >();
  for (const event of model.events) {
    if (event.kind !== "claim" || event.action !== "contended" || !player.played.has(event.id))
      continue;
    const a = event.laneId ? laneY(event.laneId) : null;
    if (a === null) continue;
    contentions.set(`${event.laneId}|${event.holderAgentId}|${event.resource}`, {
      event,
      a,
      b: event.holderLaneId ? laneY(event.holderLaneId) : null,
    });
  }

  return (
    <div
      className="pointer-events-none absolute top-0 right-0"
      style={{ width: RAIL, height: geo.height }}
    >
      <svg aria-hidden width={RAIL} height={geo.height} className="absolute inset-0">
        <path
          d={`M ${BUS_X} ${geo.headMid} V ${geo.busEnd}`}
          className="stroke-kumo-divider"
          strokeWidth={1}
          fill="none"
        />
        <rect
          x={BUS_X - 4}
          y={geo.headMid - 4}
          width={8}
          height={8}
          className="fill-kumo-elevated stroke-kumo-ink"
          strokeWidth={1.5}
        />
        {packets.map((p) => (
          <path
            key={p.id}
            d={p.d}
            className={p.accent ? "stroke-accent-500" : "stroke-kumo-divider"}
            strokeWidth={1}
            fill="none"
          />
        ))}
        {connectors.map(({ conflict, a, b, x }) => {
          const animated = player.animated.has(conflict.eventId);
          return (
            <path
              key={conflict.eventId}
              d={`M 0 ${a} H ${x} V ${b} H 0`}
              pathLength={1}
              className={cn("stroke-accent-500", animated && "rh-fork")}
              style={animated && conflict.challenged ? AFTER_PACKET : undefined}
              strokeWidth={2}
              strokeDasharray={conflict.challenged ? undefined : "4 3"}
              fill="none"
            />
          );
        })}
        {[...contentions.values()].map(({ event, a, b }) => (
          <path
            key={event.id}
            d={b === null ? `M 0 ${a} H ${CONNECTOR_X}` : `M 0 ${a} H ${CONNECTOR_X} V ${b} H 0`}
            pathLength={1}
            className={cn("stroke-kumo-warning", player.animated.has(event.id) && "rh-fork")}
            style={player.animated.has(event.id) && b !== null ? AFTER_PACKET : undefined}
            strokeWidth={1}
            strokeDasharray="2 3"
            fill="none"
          />
        ))}
      </svg>

      {[...contentions.values()].map(({ event, a, b }) => (
        <span
          key={event.id}
          title={event.detail}
          role="img"
          aria-label={event.detail}
          className={cn(
            "pointer-events-auto absolute truncate bg-kumo-elevated px-1 text-[14px] leading-4 text-kumo-warning",
            player.animated.has(event.id) && "rh-settle",
          )}
          style={{
            top: (b === null ? a : (a + b) / 2) - 8,
            left: CONNECTOR_X + 6,
            maxWidth: RAIL - CONNECTOR_X - 10,
            ...(player.animated.has(event.id) && b !== null
              ? { animationDelay: "var(--rh-dur-packet)" }
              : {}),
          }}
        >
          Contended · {event.resource}
        </span>
      ))}

      {connectors.map(({ conflict, a, b, x }) => (
        <span
          key={conflict.eventId}
          title={conflict.resource}
          className={cn(
            "pointer-events-auto absolute max-w-full truncate bg-kumo-elevated px-1 font-mono text-[10px] leading-4 text-kumo-accent",
            player.animated.has(conflict.eventId) && "rh-settle",
          )}
          style={{
            top: (a + b) / 2 - 8,
            left: x + 6,
            maxWidth: RAIL - x - 10,
            ...(player.animated.has(conflict.eventId) && conflict.challenged
              ? { animationDelay: "var(--rh-dur-packet)" }
              : {}),
          }}
        >
          {conflict.resource}
        </span>
      ))}

      {packets.map((p) => (
        <span
          key={p.id}
          aria-hidden
          className="rh-packet"
          style={
            {
              "--rh-packet-path": `path('${p.d}')`,
              ...(p.accent ? { background: "var(--color-accent-500)" } : {}),
            } as CSSProperties
          }
        >
          <span
            className={cn(
              "absolute top-1/2 left-3 -translate-y-1/2 bg-kumo-elevated px-1 font-mono text-[10px] leading-4 whitespace-nowrap",
              p.accent ? "text-kumo-accent" : "text-kumo-default",
            )}
          >
            {p.label}
          </span>
        </span>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------------------------------
 * Disputes, convergence and the event list
 * ------------------------------------------------------------------------------------------ */

function Disputes({ model, conflicts }: { model: ActivityModel; conflicts: ConflictView[] }) {
  if (conflicts.length === 0) return null;
  const keyOf = new Map(model.lanes.map((l) => [l.id, l.key]));
  return (
    <div className="grid border-t-2 border-accent-500">
      {conflicts.map((conflict) => (
        <div
          key={conflict.id}
          className="grid gap-2 border-b border-kumo-rule px-4 py-3 last:border-b-0"
        >
          <p className="flex flex-wrap items-center gap-2 text-[12px]">
            <Warning size={14} className="shrink-0 text-kumo-accent" />
            <span className="font-semibold">
              {conflict.challenged ? "Challenge" : "Possible conflict"}
            </span>
            <Mono className="text-kumo-accent">{conflict.resource}</Mono>
            <StatusPill status={conflict.state} className="ml-auto" />
          </p>
          <div className="grid gap-3 min-[720px]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <Statement lane={keyOf.get(conflict.fromLaneId) ?? "—"} text={conflict.statements[0]} />
            <span className="self-center font-mono text-[11px] text-kumo-subtle">vs</span>
            <Statement lane={keyOf.get(conflict.toLaneId) ?? "—"} text={conflict.statements[1]} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Statement({ lane, text }: { lane: string; text: string }) {
  return (
    <p className="grid min-w-0 gap-0.5 text-[13px]">
      <span className="font-mono text-[11px] text-kumo-subtle">{lane} · Intent</span>
      <span className="line-clamp-2" title={text}>
        {text}
      </span>
    </p>
  );
}

function Convergence({ model, view }: { model: ActivityModel; view: ActivityView }) {
  const candidates = model.candidates.filter((c) => view.candidates[c.id]?.forked);
  const verified = candidates.filter((c) =>
    ["verified", "promoted"].includes(view.candidates[c.id]?.status ?? ""),
  ).length;
  const first = Math.max(1, view.intents);
  const share = (n: number) => `${Math.min(100, (n / first) * 100)}%`;
  const stages: { label: string; value: string; note: string; bar: string; final?: boolean }[] = [
    {
      label: view.intents === 1 ? "Possible change" : "Possible changes",
      value: formatNumber(view.intents),
      note: "Intents declared by agents",
      bar: share(view.intents),
    },
    {
      label: candidates.length === 1 ? "Candidate" : "Candidates",
      value: formatNumber(candidates.length),
      note: "Futures composed from ChangeSets",
      bar: share(candidates.length),
    },
    {
      label: verified === 1 ? "Verified future" : "Verified futures",
      value: formatNumber(verified),
      note: "Every required check passed",
      bar: share(verified),
    },
    {
      label: "Canonical",
      value: view.promoted
        ? generation(view.promoted.generation)
        : generation(model.baseGeneration),
      note: view.promoted ? "Advanced by promotion" : "Not promoted yet",
      bar: view.promoted ? share(1) : "0%",
      final: true,
    },
  ];
  const sentence = stages.map((s) => `${s.value} ${s.label.toLowerCase()}`).join(" → ");
  return (
    <div className="min-w-0 overflow-x-auto border-t-2 border-kumo-divider">
      <ol
        aria-label={`Convergence: ${sentence}`}
        className="grid min-w-[640px] grid-cols-4 gap-px bg-kumo-rule"
      >
        {stages.map((stage, i) => (
          <li
            key={stage.label}
            className="relative grid content-start gap-1.5 bg-kumo-elevated px-4 py-3"
          >
            <span className="font-mono text-[11px] text-kumo-subtle">
              {String(i + 1).padStart(2, "0")} · {stage.label}
            </span>
            <span
              key={stage.value}
              className={cn(
                "type-display",
                stage.final && view.promoted && "text-kumo-accent",
                stage.final && "font-mono text-[28px]",
              )}
            >
              {stage.value}
            </span>
            <span className="truncate text-[12px] text-kumo-subtle">{stage.note}</span>
            <span aria-hidden className="h-1.5 bg-kumo-recessed">
              <span
                className={cn(
                  "block h-full transition-[width] duration-(--rh-dur-bar)",
                  stage.final ? "bg-accent-500" : "bg-kumo-ink",
                )}
                style={{ width: stage.bar }}
              />
            </span>
            {i < stages.length - 1 && (
              <span
                aria-hidden
                className="absolute top-3 right-2 font-mono text-[12px] text-kumo-subtle"
              >
                →
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function EventList({
  model,
  player,
  maxHeight,
  className,
}: {
  model: ActivityModel;
  player: ActivityPlayer;
  maxHeight: number;
  className?: string;
}) {
  const byId = new Map(model.events.map((e) => [e.id, e]));
  const rows = player.order
    .map((id, index) => ({ event: byId.get(id), seq: index + 1 }))
    .filter((r): r is { event: ActivityEvent; seq: number } => r.event !== undefined)
    .reverse();
  const digits = Math.max(2, String(rows.length).length);
  return (
    <section aria-label="Activity events" className={cn("grid min-w-0 content-start", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-kumo-rule px-4 py-2">
        <span className="type-label text-kumo-subtle">Events</span>
        <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
          {formatNumber(rows.length)}
          {player.waiting > 0 ? ` · ${formatNumber(player.waiting)} new` : ""}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-kumo-subtle">
          No activity recorded yet. Events appear as agents wake and report.
        </p>
      ) : (
        <ol
          className="max-h-64 overflow-y-auto min-[1500px]:max-h-(--rh-events-h)"
          style={{ "--rh-events-h": `${maxHeight}px` } as CSSProperties}
        >
          {rows.map(({ event, seq }) => (
            <li
              key={event.id}
              className={cn(
                "grid gap-0.5 border-b border-kumo-rule px-4 py-1.5",
                player.animated.has(event.id) && player.inFlight.has(event.id) && "rh-settle",
              )}
            >
              <span className="flex min-w-0 items-baseline gap-2 font-mono text-[11px] tabular-nums">
                <span className="text-kumo-subtle">{String(seq).padStart(digits, "0")}</span>
                <span className="text-kumo-subtle">
                  {formatClock(new Date(event.at).toISOString())}
                </span>
                <span className={cn("truncate font-semibold", TYPE_TEXT(event))}>{event.type}</span>
                <span className="ml-auto shrink-0 text-kumo-subtle">{event.actor}</span>
              </span>
              <span className="text-[12px] leading-snug" title={event.detail}>
                {truncate(event.detail, 160)}
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="px-4 py-2 text-[11px] text-kumo-subtle">
        From Task runs, conflicts, Candidates, Evidence, Claims and the Change's event feed. Times
        are as recorded.
      </p>
    </section>
  );
}

/**
 * @public Fixture preview for design review, for example inside routes/design.tsx. Press Replay
 * to watch the Wishlist story converge. Not used by any product page.
 */
export function AgentActivityPreview() {
  const model = useMemo(() => deriveActivity(previewActivityInput()), []);
  return <AgentActivity model={model} ready linkCandidates={false} />;
}
AgentActivityPreview.displayName = "AgentActivityPreview";
