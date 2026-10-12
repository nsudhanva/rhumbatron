import { Button, cn } from "@cloudflare/kumo";
import { Pause, Play } from "@phosphor-icons/react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef } from "react";
import { formatNumber } from "../../lib/format";
import { displayTimeZone } from "../../lib/render-time";
import type { ActivityEvent } from "../agents/activity-model";
import { StatusPill } from "../ui/status-pill";
import { useFlight } from "./flight-context";
import { type FlightTime, PLAYBACK_SPEEDS, useFlightStore, useFlightTime } from "./flight-store";

/**
 * Time machine: a range over the recorded time of the Change. Live folds every
 * fact; any other position folds only the facts recorded at or before it. Tick marks are recorded
 * notable facts (Candidate forks, conflicts, failures, promotion), placed by their time. Play
 * advances through recorded time at 1x, 4x, 8x or 16x and stops at the end. Nothing is interpolated.
 *
 * Keyboard on the range: Left/Right step to the previous/next recorded fact, Home to the start,
 * End back to live. The page maps `[` and `]` to the same steps.
 */

const TICK_MS = 100;

/**
 * The instant of the previous (-1) or next (+1) recorded fact from the current time-machine
 * position. `"live"` when stepping forward past the last fact; null when there is nothing to step to.
 */
export function stepFact(
  events: readonly ActivityEvent[],
  time: FlightTime,
  direction: -1 | 1,
): number | "live" | null {
  const current = time.mode === "live" ? Number.POSITIVE_INFINITY : time.at;
  if (direction < 0) {
    const previous = events.findLast((e) => e.at < current);
    return previous ? previous.at : null;
  }
  if (time.mode === "live") return null;
  const next = events.find((e) => e.at > current);
  return next ? next.at : "live";
}

type Notable = { id: string; at: number; label: string; fill: string };

/** Facts worth a tick on the track. Status is also in the sr-only summary, never color alone. */
function notableOf(event: ActivityEvent): Omit<Notable, "id" | "at"> | null {
  switch (event.kind) {
    case "candidate.fork":
      return { label: "Candidate fork", fill: "bg-kumo-ink" };
    case "challenge":
      return { label: "Conflict", fill: "bg-accent-500" };
    case "promoted":
      return { label: "Promotion", fill: "bg-kumo-success" };
    case "run.end":
      if (event.status !== "failed") return null;
      // A failure a later attempt recovered (or retries) is a retry, not a failure (lib/recovery).
      return event.outcome === "recovered" || event.outcome === "retrying"
        ? { label: "Retry", fill: "bg-kumo-warning" }
        : { label: "Failure", fill: "bg-tone-500" };
    case "candidate.status":
      return event.status === "rejected" ? { label: "Rejection", fill: "bg-tone-500" } : null;
    case "check":
      return event.status === "fail" || event.status === "error"
        ? { label: "Failed check", fill: "bg-tone-500" }
        : null;
    default:
      return null;
  }
}

const LEGEND = [
  { label: "Fork", fill: "bg-kumo-ink" },
  { label: "Conflict", fill: "bg-accent-500" },
  { label: "Failure", fill: "bg-tone-500" },
  { label: "Retry", fill: "bg-kumo-warning" },
  { label: "Promotion", fill: "bg-kumo-success" },
];

const pad = (n: number) => String(n).padStart(2, "0");

/** `T+02:15`, `T+1:02:15` from the first recorded fact. */
function relative(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `T+${h}:${pad(m)}:${pad(s)}` : `T+${pad(m)}:${pad(s)}`;
}

/** 24-hour clock in the viewer's zone, the same on the server and in the hydration. */
const clock = (at: number) => {
  const timeZone = displayTimeZone();
  return new Date(at).toLocaleTimeString("en-GB", {
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  });
};

export function Scrubber() {
  const { model, state } = useFlight();
  const time = useFlightTime();
  const scrubTo = useFlightStore((s) => s.scrubTo);
  const goLive = useFlightStore((s) => s.goLive);
  const setPlaying = useFlightStore((s) => s.setPlaying);
  const setSpeed = useFlightStore((s) => s.setSpeed);
  const notesId = useId();

  const { start, end, live: changeLive } = model.bounds;
  const span = Math.max(1, end - start);
  const historical = time.mode === "historical";
  const at = historical ? Math.min(Math.max(time.at, start), end) : end;
  const playing = historical && time.playing;
  const speed = historical ? time.speed : 1;

  // The playback loop reads the newest bounds without restarting on every live tick.
  const endRef = useRef(end);
  endRef.current = end;
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const timer = setInterval(() => {
      const store = useFlightStore.getState();
      if (store.time.mode !== "historical") return;
      const now = performance.now();
      const next = store.time.at + (now - last) * store.time.speed;
      last = now;
      if (next >= endRef.current) {
        store.scrubTo(endRef.current);
        store.setPlaying(false);
      } else {
        store.scrubTo(next);
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [playing]);

  const notables = useMemo(() => {
    const out: Notable[] = [];
    for (const event of model.events) {
      const n = notableOf(event);
      if (n) out.push({ id: event.id, at: event.at, ...n });
    }
    return out;
  }, [model.events]);
  const summary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of notables) counts.set(n.label, (counts.get(n.label) ?? 0) + 1);
    return [...counts].map(([label, count]) => `${count} ${label.toLowerCase()}`).join(", ");
  }, [notables]);

  const step = (direction: -1 | 1) => {
    const target = stepFact(model.events, useFlightStore.getState().time, direction);
    if (target === "live") goLive();
    else if (target !== null) scrubTo(target);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      step(1);
    } else if (e.key === "Home") {
      e.preventDefault();
      scrubTo(start);
    } else if (e.key === "End") {
      e.preventDefault();
      goLive();
    }
  };

  const play = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    // From live or the end, playback starts at the first recorded fact.
    const from = !historical || at >= end ? start : at;
    scrubTo(from);
    setPlaying(true);
  };

  const position = ((at - start) / span) * 100;
  const valueText = `${clock(at)}, ${relative(at - start)}${historical ? "" : ", live"}, ${formatNumber(state.events.length)} of ${formatNumber(model.events.length)} facts`;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-kumo-rule px-3 py-2">
      <div className="flex shrink-0 items-center gap-1.5">
        {model.events.length === 0 ? (
          <span className="text-[11px] text-kumo-subtle">No recorded facts to play yet</span>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            shape="square"
            icon={playing ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}
            aria-label={playing ? "Pause playback" : "Play recorded facts"}
            title={playing ? "Pause playback" : "Play recorded facts"}
            onClick={play}
          />
        )}
        {/* Segmented control: speed applies to playback, so it shows off live. */}
        {historical && (
          <fieldset className="flex border border-kumo-divider">
            <legend className="sr-only">Playback speed</legend>
            {PLAYBACK_SPEEDS.map((s, i) => (
              <button
                key={s}
                type="button"
                aria-pressed={speed === s}
                onClick={() => setSpeed(s)}
                className={cn(
                  "min-h-6 min-w-8 px-2 font-mono text-[11px] tabular-nums pointer-coarse:min-h-11",
                  i > 0 && "border-l border-kumo-divider",
                  speed === s ? "bg-kumo-ink text-kumo-inverse" : "hover:bg-kumo-tint",
                )}
              >
                {s}x
              </button>
            ))}
          </fieldset>
        )}
      </div>

      <p className="flex shrink-0 items-baseline gap-2 font-mono text-[12px] tabular-nums">
        <time dateTime={new Date(at).toISOString()}>{clock(at)}</time>
        <span className="text-kumo-subtle">{relative(at - start)}</span>
      </p>

      <div className="relative min-w-[200px] flex-1 pt-2.5">
        {/* Recorded notable facts, placed by time. Decorative: the summary below is the text. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-2">
          {notables.map((n) => (
            <span
              key={n.id}
              title={n.label}
              className={cn(
                "absolute top-0 size-1.5 -translate-x-1/2",
                n.fill,
                n.at > at && "opacity-45",
              )}
              style={{ left: `${((n.at - start) / span) * 100}%` }}
            />
          ))}
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-[19px] h-0.5">
          <span className="absolute inset-0 bg-tone-300" />
          <span
            className="absolute inset-y-0 left-0 bg-kumo-ink"
            style={{ width: `${position}%` }}
          />
        </div>
        <input
          type="range"
          aria-label="Time machine"
          aria-valuetext={valueText}
          aria-describedby={notesId}
          min={start}
          max={end}
          step={1000}
          value={at}
          onChange={(e) => scrubTo(Number(e.target.value))}
          onKeyDown={onKeyDown}
          className={cn(
            "relative block h-5 w-full cursor-pointer appearance-none bg-transparent",
            "[&::-webkit-slider-runnable-track]:h-5 [&::-webkit-slider-runnable-track]:bg-transparent",
            "[&::-webkit-slider-thumb]:mt-0.5 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-none",
            "[&::-moz-range-track]:h-5 [&::-moz-range-track]:bg-transparent",
            "[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-2 [&::-moz-range-thumb]:rounded-none [&::-moz-range-thumb]:border-0",
            historical
              ? "[&::-moz-range-thumb]:bg-accent-500 [&::-webkit-slider-thumb]:bg-accent-500"
              : "[&::-moz-range-thumb]:bg-kumo-ink [&::-webkit-slider-thumb]:bg-kumo-ink",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500",
          )}
        />
        <p id={notesId} className="sr-only">
          {summary ? `Recorded notable facts: ${summary}.` : "No notable facts recorded yet."}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {historical && (
          <>
            <StatusPill status="stale" family="attention" label="Historical" />
            <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
              {formatNumber(state.events.length)} / {formatNumber(model.events.length)} facts
            </span>
          </>
        )}
        <Button
          variant={historical ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={!historical}
          onClick={goLive}
        >
          {changeLive ? "Live" : "Latest"}
        </Button>
      </div>

      <ul aria-hidden className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-kumo-subtle">
        {LEGEND.map((l) => (
          <li key={l.label} className="inline-flex items-center gap-1.5">
            <span className={cn("size-1.5", l.fill)} />
            {l.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
Scrubber.displayName = "Scrubber";
