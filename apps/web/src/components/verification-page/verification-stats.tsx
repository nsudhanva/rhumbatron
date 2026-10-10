import { EMPTY, formatMs, formatNumber } from "../../lib/format";
import { formatP95, meterMax } from "../candidate/model";
import { ThresholdMeter } from "../ui/meter";
import { StatCell, StatStrip } from "../ui/stat-strip";
import { StatusPill } from "../ui/status-pill";
import type { stats as computeStats } from "./model";

type Stats = ReturnType<typeof computeStats>;

/**
 * Stat strip for the Verification page (DESIGN.md 6.2.2, 9.2). Required-check counts include
 * only `checked_supported` passes; gaps and failures are counted separately and never as met.
 */
export function VerificationStats({ stats }: { stats: Stats }) {
  const {
    total,
    verified,
    promoted,
    rejected,
    stale,
    inFlight,
    requiredMet,
    requiredTotal,
    requiredFailed,
    requiredGaps,
    requiredPending,
    medianP95,
    p95Measured,
    p95Values,
    budget,
  } = stats;
  const decided = verified + rejected;
  return (
    <StatStrip>
      <StatCell
        label="Verified"
        value={formatNumber(verified)}
        footnote={`${formatNumber(promoted)} promoted · of ${formatNumber(total)} Candidates`}
      />
      <StatCell
        label="Rejected"
        value={formatNumber(rejected)}
        pill={stale > 0 ? <StatusPill status="stale" label={`${stale} stale`} /> : undefined}
        footnote={
          decided > 0
            ? `${formatNumber(Math.round((rejected / decided) * 100))} % of decided · ${formatNumber(stale)} stale`
            : `${formatNumber(stale)} stale`
        }
      />
      <StatCell
        label="In flight"
        value={formatNumber(inFlight)}
        pill={inFlight > 0 ? <StatusPill status="verifying" /> : undefined}
        footnote="composing or verifying now"
      />
      <StatCell
        label="Required checks met"
        value={formatNumber(requiredMet)}
        unit={`/ ${formatNumber(requiredTotal)}`}
        pill={
          requiredGaps > 0 ? (
            <StatusPill status="gap" label={`${requiredGaps} gaps`} />
          ) : requiredFailed > 0 ? (
            <StatusPill status="fail" label={`${requiredFailed} failed`} />
          ) : undefined
        }
        footnote={`${formatNumber(requiredFailed)} failed · ${formatNumber(requiredGaps)} gaps · ${formatNumber(requiredPending)} pending`}
      >
        {requiredTotal > 0 && (
          <ThresholdMeter
            label="met with evidence"
            value={requiredMet}
            max={requiredTotal}
            valueText={`${formatNumber(Math.floor((requiredMet / requiredTotal) * 100))} %`}
            size="inline"
          />
        )}
      </StatCell>
      <StatCell
        label="Median p95"
        value={medianP95 === null ? EMPTY : formatNumber(Math.round(medianP95))}
        unit={medianP95 === null ? undefined : "ms"}
        pill={
          medianP95 !== null && budget !== null ? (
            <StatusPill status={medianP95 < budget ? "pass" : "fail"} />
          ) : undefined
        }
        footnote={`${formatNumber(p95Measured)} Candidates measured${
          budget === null ? "" : ` · budget ${formatMs(budget)}`
        }`}
      >
        {medianP95 !== null && budget !== null && (
          <ThresholdMeter
            label="median"
            value={medianP95}
            max={meterMax(budget, p95Values)}
            threshold={budget}
            size="inline"
            format={(n) => formatP95(n)}
          />
        )}
      </StatCell>
    </StatStrip>
  );
}
VerificationStats.displayName = "VerificationStats";
