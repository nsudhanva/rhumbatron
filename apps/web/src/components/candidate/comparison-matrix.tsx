import { cn } from "@cloudflare/kumo";
import { CheckCircle } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { CandidateDetail } from "../../lib/api";
import { formatMs, formatNumber, generation } from "../../lib/format";
import { ThresholdMeter } from "../ui/meter";
import { StatusPill } from "../ui/status-pill";
import { Term } from "../ui/term";
import {
  type CheckRow,
  candidateSentence,
  criterion,
  formatP95,
  meterMax,
  p95Budget,
  p95Of,
  recommend,
  requiredTally,
  VERDICT_STATUS,
  verdictWord,
  versionWord,
} from "./model";

/**
 * Compare versions (AGENTS.md section 38.4; spec B.2): checks run down the first column, versions
 * across, each cell an icon + word and the one-line result. Every value comes from a recorded
 * check result; model confidence is not shown or used.
 */

export type ComparedCandidate = {
  candidate: CandidateDetail;
  label: string;
  rows: CheckRow[];
};

type Criterion = { key: string; title: string; detail: string };

/** Union of every version's checks. Rows arrive in check order; keep first-seen order. */
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

/** The winner first, then the others: "Version B passed all 7 ... Version A was set aside: ...". */
export function resultSentence(items: ComparedCandidate[]): string {
  const pick = recommend(items);
  const winner = items.find((i) => i.candidate.id === pick?.id);
  const ordered = winner ? [winner, ...items.filter((i) => i !== winner)] : items;
  const sentences = ordered.map((i) => candidateSentence(i.label, i.candidate, i.rows));
  if (
    winner &&
    pick?.kind === "promotable" &&
    winner.candidate.approvalRequired &&
    !winner.candidate.approval
  ) {
    sentences.push(`A person must approve ${winner.label} before it ships.`);
  }
  return sentences.join(" ");
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
        "min-w-[220px] border-b border-l border-kumo-rule p-3 align-top",
        featured && "bg-kumo-elevated",
        className,
      )}
    >
      {children}
    </td>
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
  if (!row) return <StatusPill status="none" label="Not planned" />;
  const pill = <StatusPill status={VERDICT_STATUS[row.verdict]} label={verdictWord(row)} />;
  const p95 = row.record?.metrics?.p95Ms;
  if (row.kind === "performance" && budget !== null && p95 !== undefined) {
    return (
      <div className="grid gap-1.5">
        {pill}
        <ThresholdMeter
          label="Response time (p95)"
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
  const summary = row.record?.summary.split(" | ")[0];
  return (
    <div className="grid gap-1">
      {pill}
      {summary && (
        <p className="line-clamp-2 text-[12px] text-kumo-subtle" title={row.record?.summary}>
          {summary}
        </p>
      )}
    </div>
  );
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
  const featured = (id: string) => pick?.id === id && pick.kind !== "closest";
  const rowLabel = (title: string, detail: string) => (
    <th
      scope="row"
      className="w-[240px] min-w-[200px] border-b border-kumo-rule p-3 text-left align-top font-normal"
    >
      <span className="block text-[14px] font-semibold">{title}</span>
      <span className="block text-[12px] text-kumo-subtle">{detail}</span>
    </th>
  );

  return (
    <div className="min-w-0 overflow-x-auto rounded-lg border border-kumo-rule">
      <table
        className="w-full border-collapse text-left text-[14px]"
        style={{ minWidth: 240 + items.length * 240 }}
      >
        <caption className="sr-only">Versions compared check by check</caption>
        <thead>
          <tr>
            <th scope="col" className="border-b border-kumo-rule p-3 align-bottom">
              <span className="text-[12px] font-normal text-kumo-subtle">Check</span>
            </th>
            {items.map(({ candidate, label }) => {
              const isPick = featured(candidate.id);
              return (
                <th
                  key={candidate.id}
                  scope="col"
                  className={cn(
                    "border-b border-l border-kumo-rule p-3 text-left align-top font-normal",
                    isPick && "bg-kumo-elevated",
                  )}
                >
                  <div className="grid gap-1.5">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Link
                        to="/candidates/$candidateId"
                        params={{ candidateId: candidate.id }}
                        className="text-[16px] font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                      >
                        {label}
                      </Link>
                      <StatusPill status={candidate.status} label={versionWord(candidate.status)} />
                    </div>
                    <p className="text-[12px] text-kumo-subtle">
                      Based on {generation(candidate.baseGeneration)}
                    </p>
                    {isPick && pick && (
                      <span className="flex items-center gap-1 text-[13px] font-semibold text-kumo-success">
                        <CheckCircle size={16} aria-hidden />
                        {pick.kind === "promoted" ? "Shipped" : <Term k="readyToShip" />}
                      </span>
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
          <tr>
            {rowLabel("Required checks", "Checks that passed with a recorded result")}
            {items.map(({ candidate, rows }) => {
              const t = requiredTally(rows);
              return (
                <Cell key={candidate.id} featured={featured(candidate.id)}>
                  <span className="font-semibold">
                    {formatNumber(t.met)} of {formatNumber(t.total)} passed
                  </span>
                </Cell>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
ComparisonMatrix.displayName = "ComparisonMatrix";
