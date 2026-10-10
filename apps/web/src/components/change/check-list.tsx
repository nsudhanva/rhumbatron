import { cn } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type CandidateDetail, getCheckOutput } from "../../lib/api";
import { formatMs, formatNumber } from "../../lib/format";
import {
  type CheckRow,
  type CheckVerdict,
  criterion,
  durationMs,
  p95Budget,
  REASON_WORDS,
  verdictWord,
} from "../candidate/model";
import { TechnicalDetails } from "../candidate/technical-details";
import { StatusIcon } from "../ui/status-pill";

/**
 * Check rows (docs/ux/research-2026-10-09.md 7.4, step 3): icon, plain title, the recorded
 * summary and the duration. A row opens its details (stored output and screenshots) on click; a
 * failed row opens by itself. A check that did not run says "Not run" in amber, never green.
 */

/** Icon status per verdict; a gap is amber (WarningCircle), never green. */
const ICON_STATUS: Record<CheckVerdict, string> = {
  pass: "pass",
  fail: "fail",
  pending: "queued",
  gap: "gap",
};

function summaryLine(row: CheckRow, finished: boolean) {
  if (row.verdict === "gap") {
    const why = REASON_WORDS[row.reason ?? "missing"];
    return `${verdictWord(row)}: ${row.record?.summary ? `${why}. ${row.record.summary}` : why}`;
  }
  if (row.record) return row.record.summary;
  return finished ? "No result was recorded." : "Waiting to run.";
}

function Output({ row }: { row: CheckRow }) {
  const record = row.record;
  const output = useQuery({
    // Same key as the version page, so an opened row is not read twice.
    queryKey: ["check-output", record?.candidateId, row.checkId],
    queryFn: () =>
      getCheckOutput({ data: { candidateId: record?.candidateId ?? "", checkId: row.checkId } }),
    enabled: !!record?.r2Key,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (!record?.r2Key) return null;
  if (output.isLoading) return <p className="text-[12px] text-kumo-subtle">Loading the output…</p>;
  if (output.isError) {
    return <p className="text-[12px] text-kumo-danger">The stored output could not be loaded.</p>;
  }
  if (!output.data) return null;
  return (
    <pre className="type-mono-log max-h-72 overflow-auto rounded-md bg-kumo-recessed p-3 text-[12px] whitespace-pre-wrap">
      {output.data}
    </pre>
  );
}

function Details({ row, candidate }: { row: CheckRow; candidate: CandidateDetail }) {
  const record = row.record;
  const metrics = Object.entries(record?.metrics ?? {}).filter(([key]) => key !== "screenshots");
  const shots = Math.min(8, Math.max(0, record?.metrics?.screenshots ?? 0));
  return (
    <div className="grid gap-3 pt-2 pb-1 text-[13px]">
      <p className="text-kumo-subtle">{criterion(row, p95Budget(candidate)).detail}.</p>
      {metrics.length > 0 && (
        <dl className="flex flex-wrap gap-x-4 gap-y-1">
          {metrics.map(([key, value]) => (
            <div key={key} className="flex gap-1">
              <dt className="text-kumo-subtle">{key}</dt>
              <dd className="font-mono tabular-nums">{formatNumber(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {shots > 0 && (
        <ul aria-label="Screenshots" className="flex gap-2 overflow-x-auto pb-1">
          {Array.from({ length: shots }, (_, i) => i + 1).map((n) => {
            const src = `/evidence/${encodeURIComponent(candidate.id)}/${encodeURIComponent(row.checkId)}/${n}`;
            return (
              <li key={n} className="shrink-0">
                <a href={src} target="_blank" rel="noreferrer" className="block">
                  <img
                    src={src}
                    alt={`Screenshot ${n} of ${shots}`}
                    loading="lazy"
                    className="aspect-[16/10] w-48 rounded-md border border-kumo-rule object-cover"
                  />
                </a>
              </li>
            );
          })}
        </ul>
      )}
      <Output row={row} />
      <TechnicalDetails>
        <p className="font-mono text-[12px] break-all text-kumo-subtle">
          check {row.checkId} · {row.kind}
          {record ? ` · evidence ${record.evidenceId} · ${record.status} / ${record.coverage}` : ""}
        </p>
      </TechnicalDetails>
    </div>
  );
}

export function CheckItem({
  row,
  candidate,
  finished,
}: {
  row: CheckRow;
  candidate: CandidateDetail;
  finished: boolean;
}) {
  // A failed row opens by itself; the output is read only once the row is open.
  const [open, setOpen] = useState(row.verdict === "fail");
  const word = verdictWord(row);
  const status = ICON_STATUS[row.verdict];
  const ms = row.record ? durationMs(row.record) : null;
  const title = criterion(row, p95Budget(candidate)).title;
  return (
    <li className="border-b border-kumo-rule last:border-b-0">
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="grid cursor-pointer list-none grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-2.5 py-2.5 hover:bg-kumo-row-hover [&::-webkit-details-marker]:hidden">
          <span className="mt-0.5">
            <StatusIcon status={status} />
            <span className="sr-only">{word}: </span>
          </span>
          <span className="grid min-w-0 gap-0.5">
            <span className="text-[14px] font-semibold">
              {title}
              {!row.required && (
                <span className="ml-2 text-[12px] font-normal text-kumo-subtle">Optional</span>
              )}
            </span>
            <span
              className={cn(
                "text-[13px]",
                row.verdict === "gap" ? "text-kumo-warning" : "text-kumo-subtle",
              )}
            >
              {summaryLine(row, finished)}
            </span>
          </span>
          <span className="flex items-center gap-3 text-[12px] text-kumo-subtle tabular-nums">
            {ms !== null && <span>{formatMs(ms)}</span>}
            <span className="text-kumo-link">{open ? "Hide" : "Details"}</span>
          </span>
        </summary>
        {open && (
          <div className="pl-[26px]">
            <Details row={row} candidate={candidate} />
          </div>
        )}
      </details>
    </li>
  );
}
CheckItem.displayName = "CheckItem";

export function CheckList({
  rows,
  candidate,
  finished,
}: {
  rows: CheckRow[];
  candidate: CandidateDetail;
  finished: boolean;
}) {
  if (rows.length === 0) {
    return <p className="text-[13px] text-kumo-subtle">The checks are being planned.</p>;
  }
  return (
    <ul className="grid">
      {rows.map((row) => (
        <CheckItem key={row.checkId} row={row} candidate={candidate} finished={finished} />
      ))}
    </ul>
  );
}
CheckList.displayName = "CheckList";
