import { cn } from "@cloudflare/kumo";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { CandidateDetail } from "../../lib/api";
import type { CandidateView, CriterionAcceptance } from "../../lib/api-change";
import { EMPTY, formatMs, formatNumber, generation } from "../../lib/format";
import { ThresholdMeter } from "../ui/meter";
import { StatusPill } from "../ui/status-pill";
import { Tag } from "../ui/tag";
import {
  type CheckRow,
  candidateSentence,
  criterion,
  durationMs,
  formatP95,
  meterMax,
  p95Budget,
  p95Of,
  REASON_WORDS,
  recommend,
  requiredTally,
  VERDICT_STATUS,
} from "./model";

/**
 * Candidate comparison matrix (AGENTS.md section 38.4, DESIGN.md 9.12). Criteria run down the
 * first column, Candidates across. The recommended column has an elevated fill all the way down.
 * Every value comes from executable Evidence; model confidence is not shown or used.
 */

export type ComparedCandidate = {
  candidate: CandidateDetail;
  label: string;
  rows: CheckRow[];
  evidenceCount: number;
};

type Criterion = { key: string; title: string; detail: string };

/** Union of every Candidate's checks. Rows arrive in canonical kind order; keep first-seen order. */
function criteriaOf(items: ComparedCandidate[], budget: number | null): Criterion[] {
  const seen = new Map<string, Criterion>();
  for (const item of items) {
    for (const row of item.rows) {
      if (seen.has(row.checkId)) continue;
      seen.set(row.checkId, { key: row.checkId, ...criterion(row, budget) });
    }
  }
  return [...seen.values()];
}

/** A short machine value for a check cell: test counts, route deltas, exit code or duration. */
function cellValue(row: CheckRow): string {
  const m = row.record?.metrics;
  if (m?.testsPassed !== undefined || m?.testsFailed !== undefined) {
    return `${formatNumber(m.testsPassed ?? 0)} pass · ${formatNumber(m.testsFailed ?? 0)} fail`;
  }
  if (m?.routesAdded !== undefined || m?.routesRemoved !== undefined) {
    return `+${formatNumber(m.routesAdded ?? 0)} −${formatNumber(m.routesRemoved ?? 0)} routes`;
  }
  if (!row.record) return EMPTY;
  const exit = /^exit (-?\d+)/.exec(row.record.summary)?.[0];
  if (exit) return exit;
  const ms = durationMs(row.record);
  return ms === null ? EMPTY : formatMs(ms);
}

function Cell({
  children,
  featured,
  className,
}: {
  children: ReactNode;
  featured: boolean;
  className?: string;
}) {
  return (
    <td
      className={cn(
        "min-w-[220px] border-b border-l border-kumo-rule p-2 align-top",
        featured && "bg-kumo-elevated",
        className,
      )}
    >
      {children}
    </td>
  );
}

function ValuePill({ value, pill, note }: { value: ReactNode; pill: ReactNode; note?: ReactNode }) {
  return (
    <div className="grid gap-1">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 truncate font-mono text-[12px] tabular-nums">{value}</span>
        {pill}
      </div>
      {note && <p className="line-clamp-2 text-[11px] text-kumo-subtle">{note}</p>}
    </div>
  );
}

/** Ratio squares (DESIGN.md 9.1): one 8px square per required check, ink met, accent unmet. */
function RatioSquares({ met, total }: { met: number; total: number }) {
  if (total === 0 || total > 10) return null;
  return (
    <span aria-hidden className="flex gap-0.5">
      {Array.from({ length: total }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: squares are positional
        <span key={i} className={cn("size-2", i < met ? "bg-kumo-ink" : "bg-accent-500")} />
      ))}
    </span>
  );
}

function CheckCell({
  row,
  budget,
  scale,
}: {
  row: CheckRow | undefined;
  budget: number | null;
  scale: number;
}) {
  if (!row) {
    return <ValuePill value={EMPTY} pill={<StatusPill status="none" label="Not planned" />} />;
  }
  const pill = <StatusPill status={VERDICT_STATUS[row.verdict]} />;
  const note =
    row.verdict === "gap" && row.reason ? `Gap: ${REASON_WORDS[row.reason]}.` : row.record?.summary;
  const p95 = row.record?.metrics?.p95Ms;
  if (row.kind === "performance" && budget !== null && p95 !== undefined) {
    return (
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[12px] tabular-nums">p95 {formatP95(p95)}</span>
          {pill}
        </div>
        <ThresholdMeter
          label="budget"
          valueText={`${formatP95(p95)} / ${formatMs(budget)}`}
          value={p95}
          max={scale}
          threshold={budget}
          size="inline"
          format={(n) => formatMs(n)}
        />
      </div>
    );
  }
  return <ValuePill value={cellValue(row)} pill={pill} note={note} />;
}

function approvalCell(candidate: CandidateDetail) {
  if (candidate.approval?.decision === "granted") {
    return { value: candidate.approval.policyVersion, pill: <StatusPill status="approved" /> };
  }
  if (candidate.approval?.decision === "rejected") {
    return { value: candidate.approval.policyVersion, pill: <StatusPill status="rejected" /> };
  }
  if (!candidate.approvalRequired) {
    return { value: "not required", pill: <StatusPill status="none" label="Not required" /> };
  }
  const ready = candidate.status === "verified" && candidate.gate?.promotable;
  return {
    value: candidate.plan?.policyVersion ?? "required",
    pill: ready ? (
      <StatusPill status="waiting" />
    ) : (
      <StatusPill status="queued" label="After checks" />
    ),
  };
}

const ACCEPTANCE_PILL: Record<
  CriterionAcceptance["status"],
  { status: string; label: string; family: "ok" | "danger" | "attention" }
> = {
  met: { status: "pass", label: "Met", family: "ok" },
  not_met: { status: "fail", label: "Not met", family: "danger" },
  unclear: { status: "gap", label: "Unclear", family: "attention" },
};

const acceptanceOf = (candidate: CandidateDetail) =>
  (candidate as CandidateView).acceptance ?? null;

/** Union of every Candidate's judged acceptance criteria, in first-seen order. */
function acceptanceCriteria(items: ComparedCandidate[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    for (const a of acceptanceOf(item.candidate) ?? []) seen.add(a.criterion);
  }
  return [...seen];
}

export function ComparisonMatrix({ items }: { items: ComparedCandidate[] }) {
  const budget = items.map((i) => p95Budget(i.candidate)).find((b) => b !== null) ?? null;
  const scale =
    budget === null
      ? 0
      : meterMax(
          budget,
          items.map((i) => p95Of(i.candidate, i.rows)),
        );
  const criteria = criteriaOf(items, budget);
  const pick = recommend(items);
  const featured = (id: string) => pick?.id === id;
  const rowLabel = (title: string, detail: string, last = false) => (
    <th
      scope="row"
      className={cn(
        "w-[240px] min-w-[200px] border-b border-kumo-rule p-2 text-left align-top font-normal",
        last && "border-b-2 border-b-kumo-divider",
      )}
    >
      <span className="block text-[13px] font-semibold">{title}</span>
      <span className="block text-[11px] text-kumo-subtle">{detail}</span>
    </th>
  );

  const winner = items.find((i) => i.candidate.id === pick?.id);
  const ordered = winner ? [winner, ...items.filter((i) => i !== winner)] : items;
  const sentences = ordered.map((i) => candidateSentence(i.label, i.candidate, i.rows));
  if (
    winner &&
    pick?.kind === "promotable" &&
    winner.candidate.approvalRequired &&
    !winner.candidate.approval
  ) {
    sentences.push(`${winner.label} still needs a human approval before it can promote.`);
  }
  const selection = items
    .map((i) => (i.candidate as CandidateView).selection)
    .find((sel) => sel !== null && sel !== undefined);
  const selected = items.find((i) => i.candidate.id === selection?.winnerCandidateId);
  if (selection && selected) {
    sentences.unshift(`${selected.label} was selected: ${selection.reason}`.replace(/\.?$/, "."));
  }
  const why = sentences.join(" ");
  const accepted = acceptanceCriteria(items);

  return (
    <div className="grid gap-4">
      <div className="min-w-0 overflow-x-auto">
        <table
          className="w-full rule-ink border-collapse text-left text-[13px]"
          style={{ minWidth: 240 + items.length * 240 }}
        >
          <caption className="sr-only">Candidates compared by executable Evidence</caption>
          <thead>
            <tr>
              <th scope="col" className="border-b-2 border-kumo-divider p-2 align-bottom">
                <span className="type-label text-kumo-subtle">Criterion</span>
              </th>
              {items.map(({ candidate, label }) => {
                const isPick = featured(candidate.id);
                return (
                  <th
                    key={candidate.id}
                    scope="col"
                    className={cn(
                      "border-b-2 border-l border-b-kumo-divider border-l-kumo-rule p-2 text-left align-top font-normal",
                      isPick && "bg-kumo-elevated",
                    )}
                  >
                    <div className="grid gap-1.5">
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <span
                          className="truncate font-mono text-[11px] text-kumo-subtle"
                          title={candidate.id}
                        >
                          {candidate.id}
                        </span>
                        <StatusPill status={candidate.status} />
                      </div>
                      <Link
                        to="/candidates/$candidateId"
                        params={{ candidateId: candidate.id }}
                        className="type-h4 w-fit hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                      >
                        {label}
                      </Link>
                      <p className="text-[12px] text-kumo-subtle">
                        {candidate.changeSetIds.length === 0
                          ? "Canonical baseline"
                          : `${formatNumber(candidate.changeSetIds.length)} ChangeSets`}{" "}
                        · base {generation(candidate.baseGeneration)}
                      </p>
                      {isPick && pick && (
                        <Tag variant="outline">
                          {pick.kind === "promoted"
                            ? "Promoted"
                            : pick.kind === "promotable"
                              ? "Recommended"
                              : "Closest, not promotable"}
                        </Tag>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {criteria.map((c) => (
              <tr key={c.key}>
                {rowLabel(c.title, c.detail)}
                {items.map(({ candidate, rows }) => (
                  <Cell key={candidate.id} featured={featured(candidate.id)}>
                    <CheckCell
                      row={rows.find((r) => r.checkId === c.key)}
                      budget={budget}
                      scale={scale}
                    />
                  </Cell>
                ))}
              </tr>
            ))}
            {accepted.map((text) => (
              <tr key={`acceptance:${text}`}>
                {rowLabel("Acceptance", text)}
                {items.map(({ candidate }) => {
                  const judged = acceptanceOf(candidate)?.find((a) => a.criterion === text);
                  const pill = judged ? ACCEPTANCE_PILL[judged.status] : null;
                  return (
                    <Cell key={candidate.id} featured={featured(candidate.id)}>
                      <ValuePill
                        value={
                          judged
                            ? `${formatNumber(judged.citations.length)} ${
                                judged.citations.length === 1 ? "citation" : "citations"
                              }`
                            : EMPTY
                        }
                        pill={
                          pill ? (
                            <StatusPill
                              status={pill.status}
                              label={pill.label}
                              family={pill.family}
                            />
                          ) : (
                            <StatusPill status="none" label="Not judged" />
                          )
                        }
                      />
                    </Cell>
                  );
                })}
              </tr>
            ))}
            <tr>
              {rowLabel("Requirements met", "Required checks with a supported pass")}
              {items.map(({ candidate, rows }) => {
                const t = requiredTally(rows);
                const all = t.total > 0 && t.met === t.total;
                return (
                  <Cell key={candidate.id} featured={featured(candidate.id)}>
                    <ValuePill
                      value={
                        <span className="flex items-center gap-2">
                          {t.met} / {t.total}
                          <RatioSquares met={t.met} total={t.total} />
                        </span>
                      }
                      pill={
                        t.pending.length > 0 ? (
                          <StatusPill status="verifying" />
                        ) : (
                          <StatusPill
                            status={all ? "pass" : "fail"}
                            label={all ? "All met" : "Unmet"}
                          />
                        )
                      }
                    />
                  </Cell>
                );
              })}
            </tr>
            <tr>
              {rowLabel("Evidence count", "Records stored for this Candidate")}
              {items.map(({ candidate, evidenceCount }) => (
                <Cell key={candidate.id} featured={featured(candidate.id)}>
                  <span className="block text-right font-mono text-[12px] tabular-nums">
                    {formatNumber(evidenceCount)}
                  </span>
                </Cell>
              ))}
            </tr>
            <tr>
              {rowLabel("Failed checks", "Required checks that failed or have a gap")}
              {items.map(({ candidate, rows }) => {
                const t = requiredTally(rows);
                const bad = [...t.failed, ...t.gaps];
                return (
                  <Cell key={candidate.id} featured={featured(candidate.id)}>
                    <ValuePill
                      value={bad.length === 0 ? "none" : bad.map((r) => r.checkId).join(", ")}
                      pill={
                        bad.length === 0 ? (
                          <StatusPill status="none" family="ok" label="None" />
                        ) : (
                          <StatusPill status={t.failed.length > 0 ? "fail" : "gap"} />
                        )
                      }
                    />
                  </Cell>
                );
              })}
            </tr>
            <tr>
              {rowLabel("Approval", "Human gate under the Project policy", true)}
              {items.map(({ candidate }) => {
                const a = approvalCell(candidate);
                return (
                  <Cell
                    key={candidate.id}
                    featured={featured(candidate.id)}
                    className="border-b-2 border-b-kumo-divider"
                  >
                    <ValuePill value={a.value} pill={a.pill} />
                  </Cell>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="grid max-w-[760px] gap-1.5">
        <h3 className="type-h6">Why</h3>
        <p className="type-body text-pretty">{why}</p>
        <p className="text-[12px] text-kumo-subtle">
          {selection
            ? "Selected by the system from the evidence and the acceptance criteria; model confidence is not used."
            : "Decided by executable evidence; model confidence is not used."}
        </p>
      </div>
    </div>
  );
}
