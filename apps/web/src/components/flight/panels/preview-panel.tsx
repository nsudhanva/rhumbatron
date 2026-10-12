import { Button, cn, Dialog } from "@cloudflare/kumo";
import { CaretLeft, CaretRight, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatNumber } from "../../../lib/format";
import { FAMILY_TEXT } from "../../ui/status-pill";
import { useFlight } from "../flight-context";
import { type CandidateState, type CheckState, relatedRefs } from "../flight-model";
import { useFlightFilters, useFlightStore, useSelection } from "../flight-store";
import type { PanelProps } from "../panel-types";
import { checkView, isSettled, screenshotUrl } from "./arena/check-view";
import { RefButton } from "./arena/ref-button";

/**
 * Live application preview wall: the screenshots Browser Run recorded for each Candidate's browser
 * check, served through the same-origin proxy `/evidence/<cand>/<check>/<n>`.
 * Real Evidence only: no iframe, no simulated app. A screenshot the proxy cannot serve (signed
 * out, expired object) shows a labelled "not available" frame, never a stand-in.
 */

type Strip = {
  candidate: CandidateState;
  check: CheckState;
  count: number;
};

type Box = { strip: Strip; index: number };

export function PreviewPanel({ focused }: PanelProps) {
  const { state, ready } = useFlight();
  const selection = useSelection();
  const { query } = useFlightFilters();
  const q = query.trim().toLowerCase();
  const [box, setBox] = useState<Box | null>(null);

  const strips = useMemo<Strip[]>(() => {
    const out: Strip[] = [];
    for (const id of state.candidateOrder) {
      const candidate = state.candidates[id];
      if (!candidate) continue;
      for (const shot of candidate.screenshots) {
        const check = candidate.checks.find((c) => c.checkId === shot.checkId);
        if (!check) continue;
        out.push({ candidate, check, count: Math.min(shot.count, 8) });
      }
    }
    if (!q) return out;
    return out.filter((s) =>
      [s.candidate.id, s.candidate.name, s.check.checkId].some((v) => v.toLowerCase().includes(q)),
    );
  }, [state, q]);

  /** Browser checks with no screenshots yet: pending, not run or not checked. */
  const waiting = useMemo(() => {
    const out: { candidate: CandidateState; check: CheckState }[] = [];
    for (const id of state.candidateOrder) {
      const candidate = state.candidates[id];
      if (!candidate) continue;
      for (const check of candidate.checks) {
        if (check.kind !== "browser") continue;
        if (candidate.screenshots.some((s) => s.checkId === check.checkId)) continue;
        out.push({ candidate, check });
      }
    }
    return out;
  }, [state]);

  const related = useMemo(() => relatedRefs(state, selection), [state, selection]);

  if (!ready) {
    return (
      <div aria-hidden className="grid content-start gap-3 overflow-hidden p-3">
        <span className="h-3 w-48 animate-pulse bg-kumo-faint" />
        {[0, 1].map((r) => (
          <div key={r} className="flex gap-2">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="aspect-[16/10] w-44 shrink-0 animate-pulse bg-kumo-faint" />
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {strips.length === 0 ? (
          <div className="grid gap-2 px-3 py-3 text-[13px]">
            <p>
              <span className="font-semibold">No browser evidence recorded yet.</span>{" "}
              <span className="text-kumo-subtle">
                Screenshots appear when a Candidate's browser check runs in Browser Run.
              </span>
            </p>
            <WaitingList items={waiting} />
          </div>
        ) : (
          <div className="grid">
            {strips.map((strip) => {
              const key = `${strip.candidate.id}:${strip.check.checkId}`;
              const dim =
                selection !== null &&
                !related.has(`check:${key}`) &&
                !related.has(`candidate:${strip.candidate.id}`);
              return (
                <StripRow
                  key={key}
                  strip={strip}
                  focused={focused}
                  dim={dim}
                  onOpen={(index) => setBox({ strip, index })}
                />
              );
            })}
            {waiting.length > 0 && (
              <div className="px-3 py-2">
                <WaitingList items={waiting} />
              </div>
            )}
          </div>
        )}
      </div>
      <Lightbox box={box} onChange={setBox} />
    </div>
  );
}
PreviewPanel.displayName = "PreviewPanel";

function WaitingList({ items }: { items: { candidate: CandidateState; check: CheckState }[] }) {
  if (items.length === 0) {
    return <p className="text-[12px] text-kumo-subtle">No browser check is planned yet.</p>;
  }
  return (
    <ul aria-label="Browser checks without screenshots" className="grid">
      {items.map(({ candidate, check }) => {
        const view = checkView(check, isSettled(candidate));
        return (
          <li key={`${candidate.id}:${check.checkId}`} className="border-b border-kumo-rule">
            <RefButton
              entity={{ kind: "check", id: `${candidate.id}:${check.checkId}` }}
              className="flex w-full items-baseline gap-2 px-1 py-1 text-[12px]"
            >
              <span className="font-semibold">{candidate.name}</span>
              <span className="font-mono text-[11px] text-kumo-subtle">{check.checkId}</span>
              <span className={cn("ml-auto font-semibold", FAMILY_TEXT[view.family])}>
                {view.word}
              </span>
              <span className="text-[11px] text-kumo-subtle">{view.coverage}</span>
            </RefButton>
          </li>
        );
      })}
    </ul>
  );
}
WaitingList.displayName = "WaitingList";

/** Summary lines of the Evidence record; step names live in the check output, not the summary. */
function summaryLines(check: CheckState) {
  const summary = check.record?.summary ?? "";
  return summary
    .split(/\n|;\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function StripRow({
  strip,
  focused,
  dim,
  onOpen,
}: {
  strip: Strip;
  focused: boolean;
  dim: boolean;
  onOpen: (index: number) => void;
}) {
  const { candidate, check, count } = strip;
  const view = checkView(check, isSettled(candidate));
  const lines = summaryLines(check);
  const m = check.record?.metrics;
  return (
    <section
      aria-label={`${candidate.name}, ${check.checkId} screenshots`}
      className={cn(
        "grid gap-2 border-b-2 border-kumo-divider px-3 py-2 transition-opacity duration-(--rh-dur-ui)",
        dim && "opacity-45",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
        <RefButton entity={{ kind: "candidate", id: candidate.id }} className="px-1 font-semibold">
          {candidate.name}
        </RefButton>
        <RefButton
          entity={{ kind: "check", id: `${candidate.id}:${check.checkId}` }}
          className="px-1 font-mono text-[11px]"
        >
          {check.checkId}
        </RefButton>
        <span className={cn("font-semibold", FAMILY_TEXT[view.family])}>{view.word}</span>
        <span className="text-[11px] text-kumo-subtle">{view.coverage}</span>
        {m?.stepsTotal !== undefined && (
          <span className="ml-auto font-mono text-[11px] tabular-nums">
            {formatNumber(m.stepsPassed ?? 0)} / {formatNumber(m.stepsTotal)} steps passed
          </span>
        )}
      </div>
      <ol aria-label={`${candidate.name} screenshots`} className="flex gap-2 overflow-x-auto pb-1">
        {Array.from({ length: count }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: screenshots are numbered by position
          <li key={i} className={cn("shrink-0", focused ? "w-60" : "w-44")}>
            <Tile
              src={screenshotUrl(candidate.id, check.checkId, i + 1)}
              alt={`${candidate.name}, ${check.checkId}, step ${i + 1} of ${count}`}
              caption={`${i + 1} / ${count}`}
              onOpen={() => onOpen(i)}
            />
          </li>
        ))}
      </ol>
      <div className="grid gap-0.5 text-[12px]">
        {lines.length > 0 ? (
          lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: summary lines are positional
            <p key={i} className="font-mono text-[11px] text-kumo-default">
              {line}
            </p>
          ))
        ) : (
          <p className="text-kumo-subtle">No summary recorded.</p>
        )}
        <p className="text-[11px] text-kumo-subtle">
          Steps not recorded in the Evidence summary; select the check for its output.
        </p>
      </div>
    </section>
  );
}
StripRow.displayName = "StripRow";

/** One screenshot in a fixed 16:10 frame: no layout shift, a labelled frame when unavailable. */
function Shot({
  src,
  alt,
  fit,
  className,
}: {
  src: string;
  alt: string;
  fit: "cover" | "contain";
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  // An error that fired before hydration never reaches onError: check the settled image once.
  useEffect(() => {
    const img = ref.current;
    if (img?.complete && img.naturalWidth === 0) setFailed(true);
  }, []);
  return (
    <span
      className={cn(
        "relative block aspect-[16/10] w-full overflow-hidden border border-kumo-rule bg-kumo-faint",
        className,
      )}
    >
      {failed ? (
        <span className="absolute inset-0 grid place-items-center px-2 text-center text-[11px] text-kumo-subtle">
          Screenshot not available
        </span>
      ) : (
        <img
          ref={ref}
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className={cn(
            "size-full",
            fit === "cover" ? "object-cover object-top photo-grayscale" : "object-contain",
          )}
        />
      )}
    </span>
  );
}
Shot.displayName = "Shot";

function Tile({
  src,
  alt,
  caption,
  onOpen,
}: {
  src: string;
  alt: string;
  caption: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${alt}`}
      className="grid w-full gap-1 text-left hover:bg-kumo-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
    >
      <Shot src={src} alt={alt} fit="cover" />
      <span className="font-mono text-[10px] text-kumo-subtle tabular-nums">{caption}</span>
    </button>
  );
}
Tile.displayName = "Tile";

function Lightbox({ box, onChange }: { box: Box | null; onChange: (box: Box | null) => void }) {
  const strip = box?.strip;
  const count = strip?.count ?? 0;
  const index = box?.index ?? 0;
  const go = (delta: number) => {
    if (!box || count === 0) return;
    onChange({ ...box, index: (index + delta + count) % count });
  };
  const goRef = useRef(go);
  goRef.current = go;
  const open = box !== null;
  // Arrow keys move between screenshots while the lightbox is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") goRef.current(-1);
      if (e.key === "ArrowRight") goRef.current(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const n = index + 1;
  const alt = strip ? `${strip.candidate.name}, ${strip.check.checkId}, step ${n} of ${count}` : "";
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onChange(null)}>
      <Dialog size="xl" className="max-h-[calc(100dvh-32px)] overflow-y-auto p-4">
        {strip && (
          <div className="grid gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="grid gap-1">
                <p className="type-kicker text-kumo-accent">Browser Run Evidence</p>
                <Dialog.Title className="type-h4">
                  {strip.candidate.name} · {strip.check.checkId}
                </Dialog.Title>
              </div>
              <Dialog.Close
                aria-label="Close"
                title="Close"
                className="-mt-1 -mr-1 grid size-7 place-items-center text-kumo-subtle hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-accent-500"
              >
                <X size={16} aria-hidden />
              </Dialog.Close>
            </div>
            <Shot
              key={`${strip.candidate.id}:${strip.check.checkId}:${n}`}
              src={screenshotUrl(strip.candidate.id, strip.check.checkId, n)}
              alt={alt}
              fit="contain"
            />
            <Dialog.Description className="text-[13px]">
              Screenshot {n} of {count}, captured during the {strip.check.checkId} check of{" "}
              {strip.candidate.name}. {strip.check.record?.summary ?? ""}
            </Dialog.Description>
            <div className="flex flex-wrap items-center gap-2">
              {count > 1 && (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<CaretLeft aria-hidden />}
                    onClick={() => go(-1)}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<CaretRight aria-hidden />}
                    onClick={() => go(1)}
                  >
                    Next
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  useFlightStore
                    .getState()
                    .select({ kind: "check", id: `${strip.candidate.id}:${strip.check.checkId}` });
                  onChange(null);
                }}
              >
                Select check
              </Button>
              <span className="ml-auto font-mono text-[12px] text-kumo-subtle tabular-nums">
                {n} / {count}
              </span>
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  );
}
Lightbox.displayName = "Lightbox";
