import { Collapsible, cn, InlineCopyText } from "@cloudflare/kumo";
import { CaretRight } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type CandidateDetail, getCheckOutput, type VerificationCheck } from "../lib/api";
import { EMPTY, formatClock, formatDuration, formatMs, formatNumber } from "../lib/format";
import {
  type CheckRow,
  COVERAGE_WORDS,
  durationMs,
  isFinished,
  REASON_WORDS,
  VERDICT_STATUS,
} from "./candidate/model";
import { EmptyState } from "./ui/empty-state";
import { KeyValue } from "./ui/key-value";
import { type LogLine, LogWell } from "./ui/log-well";
import { StatusPill } from "./ui/status-pill";
import { Tag } from "./ui/tag";

/**
 * Verification Evidence for one Candidate. Each check is a
 * row that expands to its Evidence. Only a `checked_supported` pass is green; a check that did not
 * run, timed out, errored or found no signal is an attention "Gap" and never counts as a pass.
 */

const GRID =
  "grid grid-cols-[16px_minmax(180px,1.4fr)_76px_72px_minmax(120px,1fr)_72px] items-center gap-x-3";

function expectation(check: VerificationCheck) {
  const e = check.expected;
  if (e.kind === "exit_code") return `exit ${e.code}`;
  if (e.kind === "metric_below") return `${e.metric} < ${formatNumber(e.threshold)}`;
  return e.description;
}

function coverageWord(row: CheckRow, finished: boolean) {
  if (row.verdict === "pending") return "waiting for the Sandbox";
  if (row.verdict === "gap" || row.verdict === "fail") {
    if (row.reason && row.reason !== "failed") return REASON_WORDS[row.reason];
  }
  if (row.record) return COVERAGE_WORDS[row.record.coverage];
  return finished ? "no evidence recorded" : "waiting";
}

/** Summary text as log lines: the command, then the summary split on the tail separator. */
function logLines(row: CheckRow): LogLine[] {
  const lines: LogLine[] = [];
  if (row.check?.command) lines.push({ text: `$ ${row.check.command}`, role: "cmd" });
  else if (row.check?.procedure)
    lines.push({ text: `# procedure: ${row.check.procedure}`, role: "cmd" });
  if (!row.record) {
    lines.push({
      text: "SKIPPED no Evidence recorded. A missing result is a gap, not a pass.",
      role: "warn",
    });
    return lines;
  }
  const word = row.verdict === "pass" ? "PASS" : row.verdict === "fail" ? "FAIL" : "GAP";
  const role = row.verdict === "pass" ? "pass" : row.verdict === "fail" ? "fail" : "warn";
  const parts = row.record.summary.split(" | ");
  parts.forEach((text, index) => {
    lines.push(index === 0 ? { text: `${word} ${text}`, role } : { text, role: "info" });
  });
  return lines;
}

function CopyValue({ value }: { value: string }) {
  return (
    <InlineCopyText value={value} variant="mono" className="max-w-full break-all text-[12px]">
      {value}
    </InlineCopyText>
  );
}

function EvidenceDetail({ row }: { row: CheckRow }) {
  const { check, record } = row;
  const elapsed = record ? durationMs(record) : null;
  const metrics = Object.entries(record?.metrics ?? {});
  return (
    <div className="grid gap-3 border-t border-kumo-rule py-3 pr-2 pl-7">
      <KeyValue
        items={[
          {
            label: check?.command ? "Command" : "Procedure",
            value: check?.command ?? check?.procedure ?? null,
            mono: !!check?.command,
          },
          { label: "Expects", value: check ? expectation(check) : null, mono: true },
          { label: "Why it runs", value: check?.reason ?? null },
          {
            label: "Timeout",
            value: check ? formatDuration(check.timeoutMs / 1000) : null,
            mono: true,
          },
          {
            label: "Ran",
            value: record
              ? `${formatClock(record.startedAt)} → ${formatClock(record.completedAt)} · ${
                  elapsed === null ? EMPTY : formatMs(elapsed)
                }`
              : null,
            mono: true,
          },
          {
            label: "Metrics",
            value:
              metrics.length > 0
                ? metrics
                    .map(
                      ([name, value]) =>
                        `${name} ${formatNumber(value, Number.isInteger(value) ? 0 : 3)}`,
                    )
                    .join(" · ")
                : null,
            mono: true,
          },
          { label: "Evidence ID", value: record?.evidenceId ?? null, mono: true },
          {
            label: "Content hash",
            value: record ? <CopyValue value={record.contentHash} /> : null,
            mono: true,
          },
          {
            label: "Report",
            value: record?.r2Key ? <CopyValue value={record.r2Key} /> : null,
            mono: true,
          },
          {
            label: "Source refs",
            value: record && record.sourceRefs.length > 0 ? record.sourceRefs.join(" · ") : null,
            mono: true,
          },
        ]}
      />
      <CheckOutput row={row} />
    </div>
  );
}

/**
 * The stored stdout of a check, fetched when its row opens. Falls back to the recorded summary
 * when no output was stored (procedures and gaps).
 */
function CheckOutput({ row }: { row: CheckRow }) {
  const { record } = row;
  const output = useQuery({
    queryKey: ["check-output", record?.candidateId, row.checkId],
    queryFn: () =>
      getCheckOutput({ data: { candidateId: record?.candidateId ?? "", checkId: row.checkId } }),
    enabled: !!record?.r2Key,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (output.data) {
    return (
      <LogWell title={`${row.checkId} · stdout`} lines={outputLines(output.data)} maxHeight={300} />
    );
  }
  return (
    <>
      <LogWell
        title={record ? `${row.checkId} · summary` : row.checkId}
        lines={logLines(row)}
        maxHeight={220}
      />
      {output.isLoading && <p className="text-[11px] text-kumo-subtle">Loading stored output…</p>}
      {output.isError && (
        <p className="text-[11px] text-kumo-danger">Stored output could not be loaded.</p>
      )}
    </>
  );
}

/** Line roles for stored output: the `$ command` lines, pass and fail counts. */
function outputLines(text: string): LogLine[] {
  return text
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => ({
      text: line,
      role: line.startsWith("$ ")
        ? "cmd"
        : /\b[1-9]\d* fail\b|\berror\b|✗/i.test(line)
          ? "fail"
          : /\bpass\b|✓/i.test(line)
            ? "pass"
            : "info",
    }));
}

function CheckItem({ row, finished }: { row: CheckRow; finished: boolean }) {
  const elapsed = row.record ? durationMs(row.record) : null;
  return (
    <Collapsible.Root className="border-b border-kumo-rule">
      <Collapsible.Trigger
        className={cn(
          GRID,
          "group w-full cursor-pointer py-2 text-left text-[13px] transition-colors duration-(--rh-dur-ui) hover:bg-kumo-row-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500",
        )}
      >
        <CaretRight
          size={14}
          aria-hidden
          className="text-kumo-subtle transition-transform duration-(--rh-dur-ui) group-data-[panel-open]:rotate-90"
        />
        <span className="grid min-w-0 gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-[12px] font-semibold">{row.checkId}</span>
            <Tag>{row.kind}</Tag>
          </span>
          <span
            className="truncate text-[12px] text-kumo-subtle"
            title={row.record?.summary ?? undefined}
          >
            {row.record?.summary ??
              (finished
                ? "No Evidence recorded. This is a gap, not a pass."
                : "Waiting for the Sandbox")}
          </span>
        </span>
        <span className="text-[12px] text-kumo-subtle">
          {row.required ? "Required" : "Optional"}
        </span>
        <StatusPill status={VERDICT_STATUS[row.verdict]} />
        <span className="truncate text-[12px]">{coverageWord(row, finished)}</span>
        <span className="text-right font-mono text-[12px] tabular-nums">
          {elapsed === null ? EMPTY : formatMs(elapsed)}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <EvidenceDetail row={row} />
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

export function CandidateEvidence({
  candidate,
  rows,
}: {
  candidate: CandidateDetail;
  rows: CheckRow[];
}) {
  const finished = isFinished(candidate);
  if (rows.length === 0) {
    return (
      <EmptyState
        what={
          finished
            ? "No Verification Plan was built for this Candidate."
            : "Composing the Candidate."
        }
        how={
          finished
            ? "Without a plan nothing was checked, so the Candidate cannot promote."
            : "Checks appear here as the Sandbox records Evidence."
        }
      />
    );
  }
  return (
    <div className="min-w-0 overflow-x-auto">
      <div className="min-w-[720px]">
        <div
          className={cn(GRID, "type-label border-b-2 border-kumo-divider pb-2 text-kumo-subtle")}
          aria-hidden
        >
          <span />
          <span>Check</span>
          <span>Gate</span>
          <span>Result</span>
          <span>Coverage</span>
          <span className="text-right">Duration</span>
        </div>
        {rows.map((row) => (
          <CheckItem key={row.checkId} row={row} finished={finished} />
        ))}
        <p className="pt-2 text-[11px] text-kumo-subtle">
          Only a supported pass satisfies a required check. A gap never counts as a pass.
        </p>
      </div>
    </div>
  );
}
