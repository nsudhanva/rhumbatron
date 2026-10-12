import { Button, cn } from "@cloudflare/kumo";
import { Pause, Play } from "@phosphor-icons/react";
import { useId, useMemo } from "react";
import { formatNumber } from "../../lib/format";
import { displayTimeZone } from "../../lib/render-time";
import { StatusPill } from "../ui/status-pill";
import { REPLAY_SPEEDS, relativeClock } from "./replay-model";
import type { Replay } from "./use-replay";

/**
 * Replay control bar (segmented control; a replay control re-runs the
 * sequence from recorded events), in the look of the Flight Control time machine: play or
 * pause, speed, the replay clock, a range over the recorded time with a tick per notable fact,
 * and Live. The keys work anywhere in the bar: Space, Left and Right, Home, L.
 */

export type ReplayTick = {
  id: string;
  at: number;
  /** Words for the tooltip and the screen-reader summary. */
  label: string;
  /** Fill class of the tick square. */
  fill: string;
};

export type ReplayLegendItem = { label: string; fill: string };

const zone = () => {
  const timeZone = displayTimeZone();
  return timeZone ? { timeZone } : {};
};
const clock = (at: number) =>
  new Date(at).toLocaleTimeString("en-GB", { hour12: false, ...zone() });
const day = (at: number) =>
  new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...zone() });

export function ReplayBar({
  replay,
  ticks,
  legend,
  label,
  className,
}: {
  replay: Replay;
  ticks: readonly ReplayTick[];
  legend?: readonly ReplayLegendItem[];
  /** Accessible name of the bar, for example "Timeline replay". */
  label: string;
  className?: string;
}) {
  const notesId = useId();
  const { start, end, mode, playing, speed } = replay;
  const replaying = mode === "replay";
  const span = Math.max(1, end - start);
  const total = replay.schedule.times.length;
  const at = replaying ? replay.at : end;
  const position = total < 2 ? 100 : ((at - start) / span) * 100;
  const multiDay = end - start > 20 * 3_600_000;

  const summary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of ticks) counts.set(t.label, (counts.get(t.label) ?? 0) + 1);
    return [...counts].map(([l, n]) => `${n} ${l.toLowerCase()}`).join(", ");
  }, [ticks]);

  const valueText =
    total === 0
      ? "No recorded facts"
      : `${clock(at)}, ${relativeClock(at - start)}${replaying ? "" : ", live"}, ${formatNumber(replay.cursor)} of ${formatNumber(total)} facts`;

  return (
    <fieldset
      onKeyDown={(e) => void replay.onKeyDown(e)}
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-y border-kumo-rule py-2",
        className,
      )}
    >
      <legend className="sr-only">{label}</legend>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          shape="square"
          disabled={total < 2}
          icon={playing ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}
          aria-label={playing ? "Pause replay" : "Play replay"}
          title={
            total < 2
              ? "Replay needs at least two recorded facts"
              : playing
                ? "Pause (Space)"
                : "Replay the recorded facts (Space)"
          }
          onClick={replay.toggle}
        />
        <fieldset className="flex border border-kumo-divider">
          <legend className="sr-only">Replay speed</legend>
          {REPLAY_SPEEDS.map((s, i) => (
            <button
              key={s}
              type="button"
              aria-pressed={speed === s}
              onClick={() => replay.setSpeed(s)}
              className={cn(
                "min-h-6 min-w-8 px-2 font-mono text-[11px] tabular-nums transition-colors duration-(--rh-dur-ui) pointer-coarse:min-h-11",
                i > 0 && "border-l border-kumo-divider",
                speed === s ? "bg-kumo-ink text-kumo-inverse" : "hover:bg-kumo-tint",
              )}
            >
              {s}x
            </button>
          ))}
        </fieldset>
      </div>

      <p className="flex min-w-[17ch] shrink-0 items-baseline gap-2 font-mono text-[12px] tabular-nums">
        {total === 0 ? (
          <span className="text-kumo-subtle">no facts yet</span>
        ) : (
          <>
            {multiDay && <span className="text-kumo-subtle">{day(at)}</span>}
            <time dateTime={new Date(at).toISOString()}>{clock(at)}</time>
            <span className="text-kumo-subtle">{relativeClock(at - start)}</span>
          </>
        )}
      </p>

      <div className="relative min-w-[180px] flex-1 pt-2.5">
        {/* Notable facts by time. Decorative: the summary below is the text. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-2">
          {ticks.map((t) => (
            <span
              key={t.id}
              title={t.label}
              className={cn(
                "absolute top-0 size-1.5 -translate-x-1/2 transition-opacity duration-(--rh-dur-ui)",
                t.fill,
                replaying && t.at > at && "opacity-30",
              )}
              style={{ left: `${total < 2 ? 100 : ((t.at - start) / span) * 100}%` }}
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
          aria-label="Replay position"
          aria-valuetext={valueText}
          aria-describedby={notesId}
          disabled={total < 2}
          min={start}
          max={Math.max(end, start + 1)}
          step={1000}
          value={at}
          onChange={(e) => replay.seek(Number(e.target.value))}
          className={cn(
            "relative block h-5 w-full cursor-pointer appearance-none bg-transparent disabled:cursor-not-allowed",
            "[&::-webkit-slider-runnable-track]:h-5 [&::-webkit-slider-runnable-track]:bg-transparent",
            "[&::-webkit-slider-thumb]:mt-0.5 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-none",
            "[&::-moz-range-track]:h-5 [&::-moz-range-track]:bg-transparent",
            "[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-2 [&::-moz-range-thumb]:rounded-none [&::-moz-range-thumb]:border-0",
            replaying
              ? "[&::-moz-range-thumb]:bg-accent-500 [&::-webkit-slider-thumb]:bg-accent-500"
              : "[&::-moz-range-thumb]:bg-kumo-ink [&::-webkit-slider-thumb]:bg-kumo-ink",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500",
          )}
        />
        <p id={notesId} className="sr-only">
          {summary ? `Notable facts: ${summary}.` : "No notable facts recorded yet."} Space plays or
          pauses, Left and Right step between facts, Home goes to the first fact, L goes live.
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {replaying && (
          <>
            <StatusPill status="stale" family="attention" label="Replay" />
            <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
              {formatNumber(replay.cursor)} / {formatNumber(total)} facts
            </span>
          </>
        )}
        <Button
          variant={replaying ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={!replaying}
          title={
            replay.sourceLive
              ? "Show now and follow new facts (L)"
              : "Show the newest state; new facts show as they arrive (L)"
          }
          onClick={replay.goLive}
        >
          Live
        </Button>
      </div>

      <div className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-1">
        {legend && legend.length > 0 ? (
          <ul aria-hidden className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-kumo-subtle">
            {legend.map((l) => (
              <li key={l.label} className="inline-flex items-center gap-1.5">
                <span className={cn("size-1.5", l.fill)} />
                {l.label}
              </li>
            ))}
          </ul>
        ) : (
          <span />
        )}
        <p aria-hidden className="font-mono text-[10px] text-kumo-subtle">
          Space play · ← → step · Home start · L live
        </p>
      </div>
    </fieldset>
  );
}
ReplayBar.displayName = "ReplayBar";
