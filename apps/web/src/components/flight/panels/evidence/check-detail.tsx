import { Button, cn } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { getCheckOutput } from "../../../../lib/api";
import { formatClock, formatMs, formatNumber } from "../../../../lib/format";
import { COVERAGE_WORDS, durationMs, formatP95, shortHash } from "../../../candidate/model";
import { KeyValue } from "../../../ui/key-value";
import { type LogLine, LogWell } from "../../../ui/log-well";
import { FAMILY_TEXT } from "../../../ui/status-pill";
import { Tag } from "../../../ui/tag";
import { useFlight } from "../../flight-context";
import { useFlightStore } from "../../flight-store";
import { checkView, isSettled, p95OfCheck } from "../arena/check-view";

/**
 * One check's recorded Evidence (AGENTS.md 34.3, 34.4): the EvidenceRecord fields, the plan's
 * reason and command, the recorded metrics and the stored stdout. Shared by the evidence explorer
 * and the check inspector. Stdout is fetched only for the check on screen, once (staleTime
 * Infinity). A field the record does not carry says "not recorded"; a check without a supported
 * pass is a gap, never green (34.4.1).
 */

/** Splits `${candidateId}:${checkId}` at the first colon. */
export function parseCheckRef(id: string): { candidateId: string; checkId: string } {
  const cut = id.indexOf(":");
  return cut < 0
    ? { candidateId: id, checkId: "" }
    : { candidateId: id.slice(0, cut), checkId: id.slice(cut + 1) };
}

/** Section with an h6 label over a 2px divider (inspector blocks). */
export function DetailBlock({
  label,
  meta,
  children,
}: {
  label: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid min-w-0 content-start gap-1.5">
      <div className="flex items-end justify-between gap-3 border-b border-kumo-rule pb-1">
        <h3 className="type-h6">{label}</h3>
        {meta !== undefined && <span className="text-[12px] text-kumo-subtle">{meta}</span>}
      </div>
      {children}
    </section>
  );
}
DetailBlock.displayName = "DetailBlock";

const NOT_RECORDED = <span className="text-kumo-subtle">not recorded</span>;
const clock = (iso: string | undefined) => (iso ? formatClock(iso) : null);

/** Line roles for stored output: `$`/`>` commands, failures, warnings, passes. */
function outputLines(text: string): LogLine[] {
  return text
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      let role: LogLine["role"] = "info";
      if (trimmed.startsWith("$") || trimmed.startsWith(">")) role = "cmd";
      else if (/\bFAIL(ED)?\b|\berror\b|\b[1-9]\d* fail(ed)?\b/i.test(line)) role = "fail";
      else if (/\bwarn(ing)?\b/i.test(line)) role = "warn";
      else if (/\bPASS(ED)?\b|\bok\b/i.test(line)) role = "pass";
      return { text: line, role };
    });
}

function StoredOutput({
  candidateId,
  checkId,
  enabled,
}: {
  candidateId: string;
  checkId: string;
  enabled: boolean;
}) {
  const output = useQuery({
    queryKey: ["check-output", candidateId, checkId],
    queryFn: () => getCheckOutput({ data: { candidateId, checkId } }),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
  if (!enabled) {
    return (
      <p className="text-[12px] text-kumo-subtle">No Evidence recorded, so no stored output.</p>
    );
  }
  if (output.isPending) {
    return (
      <div aria-busy className="grid gap-1.5">
        <span className="h-[13px] w-2/3 animate-pulse bg-kumo-faint motion-reduce:animate-none" />
        <span className="h-[13px] w-1/2 animate-pulse bg-kumo-faint motion-reduce:animate-none" />
        <span className="sr-only">Loading stored output</span>
      </div>
    );
  }
  if (output.isError) {
    return (
      <p className="text-[12px] text-kumo-warning">
        Output unavailable: the stored output could not be loaded.
      </p>
    );
  }
  if (output.data === null || output.data === undefined || output.data === "") {
    return <p className="text-[12px] text-kumo-subtle">No stored output for this check.</p>;
  }
  return <LogWell title={`${checkId} · stdout`} lines={outputLines(output.data)} maxHeight={300} />;
}
StoredOutput.displayName = "StoredOutput";

export function CheckDetail({
  candidateId,
  checkId,
  className,
}: {
  candidateId: string;
  checkId: string;
  className?: string;
}) {
  const { state } = useFlight();
  const setFocus = useFlightStore((s) => s.setFocus);
  const candidate = state.candidates[candidateId];
  const check = candidate?.checks.find((c) => c.checkId === checkId);
  if (!candidate || !check) {
    return (
      <p className={cn("text-[12px] text-kumo-subtle", className)}>
        This check is not part of the fold at the selected instant. Move the time machine forward or
        go live.
      </p>
    );
  }
  const view = checkView(check, isSettled(candidate));
  const record = check.record;
  const ms = record ? durationMs(record) : null;
  const p95 = p95OfCheck(state, candidate, check);
  const shots = candidate.screenshots.find((s) => s.checkId === checkId);
  const metrics = Object.entries(record?.metrics ?? {});

  return (
    <div className={cn("grid min-w-0 content-start gap-4", className)}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
        <span className={cn("font-semibold", FAMILY_TEXT[view.family])}>{view.word}</span>
        <span
          className={cn(
            check.coverage === "checked_supported" ? "text-kumo-subtle" : "text-kumo-warning",
          )}
        >
          {check.coverage ? COVERAGE_WORDS[check.coverage] : "no evidence"}
        </span>
        <Tag variant={check.required ? "outline" : "neutral"}>
          {check.required ? "required" : "optional"}
        </Tag>
        <span className="font-mono text-kumo-subtle">{check.kind}</span>
        {p95 !== null && <span className="font-mono">p95 {formatP95(p95)}</span>}
      </div>

      <DetailBlock label="Plan">
        <KeyValue
          items={[
            { label: "Reason", value: check.reason || NOT_RECORDED },
            {
              label: "Command",
              value: check.command ? (
                <code className="font-mono text-[12px] break-all">{check.command}</code>
              ) : (
                NOT_RECORDED
              ),
            },
          ]}
        />
      </DetailBlock>

      <DetailBlock label="Evidence record">
        {record ? (
          <KeyValue
            items={[
              { label: "Evidence", value: record.evidenceId, mono: true },
              {
                label: "Content hash",
                value: <span title={record.contentHash}>{shortHash(record.contentHash)}</span>,
                mono: true,
              },
              { label: "R2 key", value: record.r2Key ?? NOT_RECORDED, mono: true },
              { label: "Started", value: clock(record.startedAt), mono: true },
              { label: "Completed", value: clock(record.completedAt), mono: true },
              {
                label: "Duration",
                value: ms === null ? NOT_RECORDED : formatMs(ms),
                mono: true,
              },
              { label: "Summary", value: record.summary || NOT_RECORDED },
              {
                label: "Source refs",
                value:
                  record.sourceRefs.length > 0 ? (
                    <ul className="grid gap-0.5">
                      {record.sourceRefs.map((ref) => (
                        <li key={ref} className="break-all">
                          {ref}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    NOT_RECORDED
                  ),
                mono: true,
              },
            ]}
          />
        ) : (
          <p className="text-[12px] text-kumo-warning">
            {view.word === "Not run"
              ? "The Candidate settled without Evidence for this check: it is a gap, not a pass."
              : "No Evidence recorded for this check at the selected instant."}
          </p>
        )}
      </DetailBlock>

      {record && (
        <DetailBlock
          label="Metrics"
          meta={metrics.length > 0 ? formatNumber(metrics.length) : null}
        >
          {metrics.length > 0 ? (
            <KeyValue
              items={metrics.map(([key, value]) => ({
                label: key,
                value: formatNumber(value),
                mono: true,
              }))}
            />
          ) : (
            <p className="text-[12px] text-kumo-subtle">No metrics recorded.</p>
          )}
          {shots && shots.count > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <span>
                {formatNumber(shots.count)} {shots.count === 1 ? "screenshot" : "screenshots"} — see
                Preview wall
              </span>
              <Button size="xs" variant="secondary" onClick={() => setFocus("preview")}>
                Open Preview wall
              </Button>
            </div>
          )}
        </DetailBlock>
      )}

      <DetailBlock label="Stored output">
        <StoredOutput candidateId={candidateId} checkId={checkId} enabled={record !== null} />
      </DetailBlock>
    </div>
  );
}
CheckDetail.displayName = "CheckDetail";
