import { cn } from "@cloudflare/kumo";
import { type CSSProperties, useEffect, useMemo, useRef } from "react";
import { formatClock, formatNumber } from "../../lib/format";
import type { Replay } from "../replay/use-replay";
import {
  type AgentsTiming,
  agentAt,
  type ChangeData,
  factLine,
  TIER_LETTER,
  TIER_WORD,
} from "./agents-replay";

/**
 * The strip under the Agents graph (DESIGN.md 9.8 trace rows, 11.1 lanes): one lane per agent
 * with a bar per attempt over the replayed time, the playhead across every lane, and the latest
 * steps as words beside it. The playhead and the bar reveal follow every animation frame
 * through the `--rh-ph` variable (0 to 1 of the time span); bars change colour when the
 * playhead passes their recorded end. The step list is the reduced-motion view of the replay
 * and its newest line is announced politely while a replay runs.
 */

const MAX_LANES = 14;
const STEPS = 5;

export function AgentsReplayStrip({
  data,
  timing,
  replay,
}: {
  data: readonly ChangeData[];
  timing: AgentsTiming;
  replay: Replay;
}) {
  const { start, end } = replay;
  const span = Math.max(1, end - start);
  const replaying = replay.mode === "replay";
  const at = replaying ? replay.at : null;
  const share = (t: number) => Math.min(1, Math.max(0, (t - start) / span));

  const lanes = useMemo(() => {
    const out = data.flatMap(({ tasks }) =>
      tasks
        .filter((t) => t.runs.length > 0)
        .map((task) => ({
          task,
          first: Math.min(...task.runs.map((r) => Date.parse(r.startedAt) || end)),
        })),
    );
    return out.sort((a, b) => a.first - b.first).slice(0, MAX_LANES);
  }, [data, end]);
  const hiddenLanes =
    data.reduce((n, d) => n + d.tasks.filter((t) => t.runs.length > 0).length, 0) - lanes.length;

  // Every frame: the playhead variable on the strip.
  const strip = useRef<HTMLDivElement>(null);
  const { subscribe } = replay;
  const startRef = useRef({ start, span });
  startRef.current = { start, span };
  useEffect(
    () =>
      subscribe((t) => {
        const { start: s, span: w } = startRef.current;
        strip.current?.style.setProperty("--rh-ph", String(Math.min(1, Math.max(0, (t - s) / w))));
      }),
    [subscribe],
  );

  const shown = at === null ? timing.facts : timing.facts.filter((f) => f.at <= at);
  const steps = shown.slice(-STEPS);
  const current = replaying ? shown.at(-1) : undefined;

  return (
    <div className="@container min-w-0">
      <div className="grid min-w-0 items-start gap-4 @min-[760px]:grid-cols-[minmax(0,1fr)_minmax(240px,320px)]">
        <div
          ref={strip}
          className="grid min-w-0 gap-1 border-t-2 border-kumo-divider pt-2"
          style={{ "--rh-ph": at === null ? 1 : share(at) } as CSSProperties}
        >
          <p className="flex items-baseline justify-between gap-2 text-[11px] text-kumo-subtle">
            <span className="tracking-[0.08em] uppercase">Agent lanes over time</span>
            <span className="font-mono tabular-nums">
              {formatClock(new Date(start).toISOString())} →{" "}
              {formatClock(new Date(end).toISOString())}
            </span>
          </p>
          {lanes.length === 0 ? (
            <p className="text-[12px] text-kumo-subtle">No agent has run in these Changes yet.</p>
          ) : (
            <div className="relative grid gap-1">
              {lanes.map(({ task }) => {
                const state = at === null ? null : agentAt(task, at);
                return (
                  <div key={task.id} className="grid grid-cols-[64px_minmax(0,1fr)] items-center">
                    <span
                      className="truncate font-mono text-[10px] text-kumo-subtle"
                      title={`${task.key} ${task.title}`}
                    >
                      {task.key}
                      {state?.current ? ` ${TIER_LETTER[state.current.tier]}` : ""}
                    </span>
                    <span aria-hidden className="relative block h-2 bg-kumo-faint">
                      {task.runs.map((run) => {
                        const s = Date.parse(run.startedAt);
                        if (Number.isNaN(s)) return null;
                        const e = run.endedAt ? Date.parse(run.endedAt) : end;
                        const left = share(s);
                        const width = Math.max(0.004, share(e) - left);
                        const ended = run.status !== "running" && (at === null || e <= at);
                        return (
                          <span
                            key={run.attempt}
                            title={`${task.key} · ${TIER_WORD[run.tier]} · attempt ${run.attempt}`}
                            className={cn(
                              "absolute inset-y-0 transition-colors duration-(--rh-dur-ui)",
                              !ended
                                ? "bg-kumo-ink"
                                : run.status === "failed"
                                  ? "bg-kumo-danger"
                                  : "bg-kumo-success",
                            )}
                            style={{
                              left: `${left * 100}%`,
                              width: `${width * 100}%`,
                              ...(at === null
                                ? {}
                                : {
                                    clipPath: `inset(0 calc((1 - clamp(0, (var(--rh-ph) - ${left}) / ${width}, 1)) * 100%) 0 0)`,
                                  }),
                            }}
                          />
                        );
                      })}
                    </span>
                  </div>
                );
              })}
              {at !== null && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 right-0 left-16 block"
                >
                  <span
                    className="absolute inset-y-[-4px] w-0.5 bg-accent-500"
                    style={{ left: "calc(var(--rh-ph) * 100% - 1px)" }}
                  />
                </span>
              )}
            </div>
          )}
          <ul
            aria-hidden
            className="flex flex-wrap gap-x-3 gap-y-1 pt-1 text-[11px] text-kumo-subtle"
          >
            <li className="inline-flex items-center gap-1.5">
              <span className="h-2 w-3 bg-kumo-ink" />
              Running
            </li>
            <li className="inline-flex items-center gap-1.5">
              <span className="h-2 w-3 bg-kumo-success" />
              Done
            </li>
            <li className="inline-flex items-center gap-1.5">
              <span className="h-2 w-3 bg-kumo-danger" />
              Failed
            </li>
            {hiddenLanes > 0 && <li>{formatNumber(hiddenLanes)} more agents not drawn</li>}
          </ul>
        </div>

        <div className="grid min-w-0 gap-1 border-t-2 border-kumo-divider pt-2">
          <p className="text-[11px] tracking-[0.08em] text-kumo-subtle uppercase">
            {replaying ? "Steps to the playhead" : "Latest steps"}
          </p>
          {steps.length === 0 ? (
            <p className="text-[12px] text-kumo-subtle">No recorded steps yet.</p>
          ) : (
            <ol className="grid">
              {steps.map((f) => (
                <li
                  key={f.id}
                  className={cn(
                    "border-b border-kumo-rule py-1 pl-2 text-[12px] leading-snug",
                    f === current
                      ? "border-l-2 border-l-accent-500 font-semibold"
                      : "border-l-2 border-l-transparent",
                  )}
                >
                  <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">
                    {formatClock(new Date(f.at).toISOString())}
                  </span>{" "}
                  {f.text}
                </li>
              ))}
            </ol>
          )}
          <p className="sr-only" aria-live={replaying ? "polite" : "off"} aria-atomic="true">
            {current ? factLine(current) : ""}
          </p>
        </div>
      </div>
    </div>
  );
}
AgentsReplayStrip.displayName = "AgentsReplayStrip";
