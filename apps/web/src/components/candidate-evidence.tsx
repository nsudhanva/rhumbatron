import { cn, InlineCopyText } from "@cloudflare/kumo";
import { CaretDown, CheckCircle, Circle, WarningCircle, XCircle } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type CandidateDetail, getCheckOutput, type VerificationCheck } from "../lib/api";
import { EMPTY, formatClock, formatDuration, formatMs, formatNumber } from "../lib/format";
import {
  type CheckRow,
  criterion,
  durationMs,
  isFinished,
  p95Budget,
  REASON_WORDS,
  verdictWord,
} from "./candidate/model";
import { TechnicalDetails } from "./candidate/technical-details";
import { EmptyState } from "./ui/empty-state";
import { KeyValue } from "./ui/key-value";
import { type LogLine, LogWell } from "./ui/log-well";

/**
 * Checks for one version (AGENTS.md sections 34.3, 34.4, 34.4.1; spec 6.2 P3, 7.4 step 3). Each
 * row is an icon, a plain title, a one-line summary and a duration; "Details" opens the recorded
 * output. A failed row opens on its own. Only a recorded pass is green: a check that did not run,
 * timed out, errored or found no result is amber "Not run" and never counts as a pass.
 */

function expectation(check: VerificationCheck) {
  const e = check.expected;
  if (e.kind === "exit_code") return `exit ${e.code}`;
  if (e.kind === "metric_below") return `${e.metric} < ${formatNumber(e.threshold)}`;
  return e.description;
}

const firstPart = (summary: string) => summary.split(" | ")[0] ?? summary;

/** The one line under a check title. Gaps say what is missing, in amber. */
function rowLine(row: CheckRow, finished: boolean): string {
  const summary = row.record ? firstPart(row.record.summary) : null;
  if (row.verdict === "pending") return finished ? "No result recorded." : "Waiting to run.";
  if (row.verdict === "gap") {
    if (row.reason === "error") return `Couldn't run${summary ? `: ${summary}` : "."}`;
    if (row.reason === "no_signal") return `No result${summary ? `: ${summary}` : "."}`;
    if (row.reason === "not_checked" && summary) return `Not run: ${summary}`;
    return `Not run: ${REASON_WORDS[row.reason ?? "missing"]}.`;
  }
  return summary ?? (row.verdict === "pass" ? "Passed." : "Failed.");
}

function VerdictIcon({ row }: { row: CheckRow }) {
  const props = { size: 16, className: "mt-0.5 shrink-0", "aria-hidden": true } as const;
  if (row.verdict === "pass")
    return <CheckCircle {...props} className={cn(props.className, "text-kumo-success")} />;
  if (row.verdict === "fail")
    return <XCircle {...props} className={cn(props.className, "text-kumo-danger")} />;
  if (row.verdict === "gap") {
    return <WarningCircle {...props} className={cn(props.className, "text-kumo-warning")} />;
  }
  return <Circle {...props} className={cn(props.className, "text-kumo-subtle")} />;
}

/** Summary text as log lines: the command, then the summary split on the tail separator. */
function logLines(row: CheckRow): LogLine[] {
  const lines: LogLine[] = [];
  if (row.check?.command) lines.push({ text: `$ ${row.check.command}`, role: "cmd" });
  else if (row.check?.procedure) lines.push({ text: `# ${row.check.procedure}`, role: "cmd" });
  if (!row.record) {
    lines.push({
      text: "Not run: no result recorded. A missing result never counts as a pass.",
      role: "warn",
    });
    return lines;
  }
  const role = row.verdict === "pass" ? "pass" : row.verdict === "fail" ? "fail" : "warn";
  row.record.summary.split(" | ").forEach((text, index) => {
    lines.push(
      index === 0 ? { text: `${verdictWord(row)}: ${text}`, role } : { text, role: "info" },
    );
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

function CheckDetail({ row }: { row: CheckRow }) {
  const { check, record } = row;
  const elapsed = record ? durationMs(record) : null;
  const metrics = Object.entries(record?.metrics ?? {});
  return (
    <div className="grid gap-3 pt-1 pr-2 pb-3 pl-7">
      <CheckOutput row={row} />
      <KeyValue
        items={[
          { label: "Why it runs", value: check?.reason ?? null },
          {
            label: check?.command ? "Command" : "How it is checked",
            value: check?.command ?? check?.procedure ?? null,
            mono: !!check?.command,
          },
          { label: "Expects", value: check ? expectation(check) : null, mono: true },
          {
            label: "Time limit",
            value: check ? formatDuration(check.timeoutMs / 1000) : null,
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
            label: "Numbers",
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
        ]}
      />
      <TechnicalDetails>
        <KeyValue
          items={[
            { label: "Check ID", value: row.checkId, mono: true },
            { label: "Kind", value: row.kind, mono: true },
            { label: "Evidence ID", value: record?.evidenceId ?? null, mono: true },
            { label: "Coverage", value: record?.coverage ?? null, mono: true },
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
      </TechnicalDetails>
    </div>
  );
}

/**
 * The stored output of a check, fetched when its row opens. Falls back to the recorded summary
 * when no output was stored (procedures and checks that did not run).
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
    return <LogWell title="Output" lines={outputLines(output.data)} maxHeight={300} />;
  }
  return (
    <>
      <LogWell title="Summary" lines={logLines(row)} maxHeight={220} />
      {output.isLoading && <p className="text-[12px] text-kumo-subtle">Loading the output…</p>}
      {output.isError && (
        <p className="text-[12px] text-kumo-danger">The stored output could not be loaded.</p>
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

function CheckItem({
  row,
  finished,
  budget,
}: {
  row: CheckRow;
  finished: boolean;
  budget: number | null;
}) {
  // A failed check opens on its own (spec 6.2 P3); the output loads only while a row is open.
  const [open, setOpen] = useState(row.verdict === "fail");
  const elapsed = row.record ? durationMs(row.record) : null;
  const { title } = criterion(row, budget);
  const line = rowLine(row, finished);
  return (
    <li className="border-b border-kumo-rule last:border-b-0">
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="group">
        <summary className="grid cursor-pointer list-none grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-2.5 transition-colors duration-150 hover:bg-kumo-row-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500 [&::-webkit-details-marker]:hidden">
          <VerdictIcon row={row} />
          <span className="grid min-w-0 gap-0.5">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="text-[14px] font-semibold">{title}</span>
              <span className="sr-only">{verdictWord(row)}</span>
              {!row.required && <span className="text-[12px] text-kumo-subtle">Optional</span>}
            </span>
            <span
              className={cn(
                "line-clamp-2 text-[13px] text-pretty",
                row.verdict === "gap" ? "text-kumo-warning" : "text-kumo-subtle",
                row.verdict === "fail" && "text-kumo-danger",
              )}
              title={row.record?.summary ?? undefined}
            >
              {line}
            </span>
          </span>
          <span className="flex items-center gap-3 text-[12px] whitespace-nowrap">
            <span className="font-mono text-kumo-subtle tabular-nums">
              {elapsed === null ? "" : formatMs(elapsed)}
            </span>
            <span className="flex items-center gap-1 text-kumo-link">
              Details
              <CaretDown
                size={12}
                aria-hidden
                className="transition-transform duration-150 group-open:rotate-180"
              />
            </span>
          </span>
        </summary>
        {open && <CheckDetail row={row} />}
      </details>
    </li>
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
  const budget = p95Budget(candidate);
  if (rows.length === 0) {
    return (
      <EmptyState
        what={finished ? "No checks were planned for this version." : "Assembling this version."}
        how={
          finished
            ? "Without a plan nothing was checked, so this version can't ship."
            : "Checks appear here as they finish."
        }
      />
    );
  }
  return (
    <div className="grid gap-2">
      <ul className="grid rounded-lg border border-kumo-rule bg-kumo-elevated">
        {rows.map((row) => (
          <CheckItem key={row.checkId} row={row} finished={finished} budget={budget} />
        ))}
      </ul>
      <p className="text-[12px] text-kumo-subtle">
        Only a recorded pass counts. A check that did not run never counts as a pass.
      </p>
    </div>
  );
}
