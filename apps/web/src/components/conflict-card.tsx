import { WarningCircle } from "@phosphor-icons/react";
import type { ConflictDetail } from "../lib/api";
import { readableArea } from "./change/headline";

/**
 * One open design conflict as a plain callout (docs/ux/research-2026-10-09.md 7.4, step 2): the
 * area, both approaches in one line each, and what Rhumbatron does next. Locks, concern IDs and
 * signal severities stay in the Debug view.
 */
function nextStep(conflict: ConflictDetail) {
  const fork = conflict.forkDecision;
  if (fork.kind === "fork") {
    return "Rhumbatron will build both versions and keep the one that passes the checks.";
  }
  if (fork.kind === "blocked") {
    return `Rhumbatron cannot build another version: the limit is ${fork.maxCandidates} per change. A reviewer decides which approach to keep.`;
  }
  if (fork.reason === "benign_overlap")
    return "The approaches can live together. No action needed.";
  return "A reviewer checks whether the two approaches really conflict.";
}

export function ConflictCallout({ conflict }: { conflict: ConflictDetail }) {
  const [a, b] = conflict.intents;
  const assumptions = [...a.assumptions, ...b.assumptions];
  return (
    <section
      aria-label={`Conflict on ${readableArea(conflict.resource)}`}
      className="grid gap-2 rounded-lg border border-kumo-warning bg-kumo-warning-tint p-4 text-[14px]"
    >
      <h4 className="flex items-start gap-2 font-semibold">
        <WarningCircle size={16} aria-hidden className="mt-0.5 shrink-0 text-kumo-warning" />
        <span>Two agents chose different approaches for {readableArea(conflict.resource)}.</span>
      </h4>
      <dl className="grid gap-1 pl-6">
        <div>
          <dt className="inline font-semibold">Approach A: </dt>
          <dd className="inline">{a.summary}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">Approach B: </dt>
          <dd className="inline">{b.summary}</dd>
        </div>
      </dl>
      <p className="pl-6">{nextStep(conflict)}</p>
      {(conflict.signals.length > 0 || assumptions.length > 0) && (
        <details className="pl-6">
          <summary className="cursor-pointer text-[13px] font-semibold text-kumo-link">
            Why they conflict
          </summary>
          <ul className="mt-2 grid list-disc gap-1 pl-5 text-[13px]">
            {conflict.signals.map((signal) => (
              <li key={`${signal.kind}:${signal.detail}`}>{signal.detail}</li>
            ))}
            {a.assumptions.map((item) => (
              <li key={`a:${item}`}>Approach A assumes: {item}</li>
            ))}
            {b.assumptions.map((item) => (
              <li key={`b:${item}`}>Approach B assumes: {item}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
ConflictCallout.displayName = "ConflictCallout";
