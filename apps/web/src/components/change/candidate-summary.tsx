import { Link } from "@tanstack/react-router";
import type { EvidenceRecord } from "../../lib/api";
import type { CandidateView } from "../../lib/api-change";
import { formatNumber, generation } from "../../lib/format";
import {
  AcceptanceList,
  acceptanceSummary,
  NoAcceptanceResult,
} from "../candidate/acceptance-list";
import {
  type CheckRow,
  candidateLabels,
  candidateSentence,
  checkRows,
  isActive,
  recommend,
  requiredTally,
} from "../candidate/model";
import { CandidateList } from "../candidate-list";
import { Section } from "../ui/page";
import { StatusPill } from "../ui/status-pill";
import { CriteriaList } from "./change-overview";
import { Disclosure } from "./disclosure";

/**
 * The result of a Change in one block (AGENTS.md sections 34, 38.2): the leading Candidate, why
 * it leads, and each acceptance criterion as met or not met. Other Candidates get one line with
 * the reason they were not selected. The full table and check details are one click away.
 */

type Item = {
  candidate: CandidateView;
  label: string;
  rows: CheckRow[];
};

/** The system's selection when recorded, else the evidence-based recommendation. */
function leader(items: Item[]) {
  const selection = items.map((i) => i.candidate.selection).find((s) => s);
  if (selection) {
    const item = items.find((i) => i.candidate.id === selection.winnerCandidateId);
    if (item) return { item, reason: selection.reason, selected: true };
  }
  const pick = recommend(items);
  const item = items.find((i) => i.candidate.id === pick?.id);
  if (!item || !pick) return null;
  return {
    item,
    reason: candidateSentence(item.label, item.candidate, item.rows),
    selected: pick.kind !== "closest",
  };
}

export function CandidateSummary({
  changeId,
  candidates,
  evidence,
  criteria,
  canCompose,
}: {
  changeId: string;
  candidates: CandidateView[];
  evidence: Record<string, EvidenceRecord[] | undefined>;
  /** The Change's acceptance criteria, shown as pending until a Candidate is judged. */
  criteria: string[];
  canCompose: boolean;
}) {
  const names = candidateLabels(candidates);
  const items: Item[] = [...candidates]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((candidate) => ({
      candidate,
      label: names.get(candidate.id) ?? candidate.id,
      rows: checkRows(candidate, evidence[candidate.id] ?? []),
    }));
  const lead = leader(items);
  const others = items.filter((i) => i !== lead?.item);
  const verifying = items.filter((i) => isActive(i.candidate)).length;
  const acceptance = lead?.item.candidate.acceptance ?? null;

  return (
    <Section
      label="Result"
      meta={
        items.length >= 2 && (
          <Link
            to="/compare/$changeId"
            params={{ changeId }}
            className="font-semibold text-kumo-link hover:underline"
          >
            Compare candidates
          </Link>
        )
      }
    >
      {items.length === 0 ? (
        <p className="text-[13px] text-kumo-subtle">
          No Candidate yet. When the tasks finish, their work is combined into a Candidate and
          checked against these criteria.
        </p>
      ) : lead ? (
        <Leader item={lead.item} reason={lead.reason} selected={lead.selected} />
      ) : (
        <p className="text-[13px]">
          {formatNumber(verifying)} of {formatNumber(items.length)}{" "}
          {items.length === 1 ? "Candidate is" : "Candidates are"} still being checked.
        </p>
      )}

      <div className="grid gap-1">
        <h3 className="type-label flex items-center justify-between gap-3 text-kumo-subtle">
          <span>Acceptance criteria</span>
          {acceptance && acceptance.length > 0 && (
            <span className="font-mono normal-case tracking-normal">
              {acceptanceSummary(acceptance)}
            </span>
          )}
        </h3>
        {acceptance && acceptance.length > 0 ? (
          <AcceptanceList items={acceptance} />
        ) : items.length > 0 && criteria.length > 0 ? (
          <NoAcceptanceResult
            criteria={criteria}
            subject={lead ? "this candidate" : "any candidate yet"}
          />
        ) : (
          <CriteriaList items={criteria} />
        )}
      </div>

      {others.length > 0 && (
        <ul className="grid">
          {others.map((o) => (
            <OtherCandidate key={o.candidate.id} item={o} />
          ))}
        </ul>
      )}

      <Disclosure
        label="All candidates and checks"
        meta={`${formatNumber(items.length)} ${items.length === 1 ? "Candidate" : "Candidates"}`}
        className="border-t border-kumo-rule pt-1"
      >
        <CandidateList changeId={changeId} candidates={candidates} canCompose={canCompose} />
      </Disclosure>
    </Section>
  );
}
CandidateSummary.displayName = "CandidateSummary";

function Leader({ item, reason, selected }: { item: Item; reason: string; selected: boolean }) {
  const { candidate } = item;
  const tally = requiredTally(item.rows);
  return (
    <div className="grid gap-1.5 bg-kumo-elevated p-3 shadow-[inset_2px_0_0_var(--color-kumo-ink)]">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/candidates/$candidateId"
          params={{ candidateId: candidate.id }}
          className="type-h5 hover:underline"
        >
          {item.label}
        </Link>
        <StatusPill status={candidate.status} />
        {selected && candidate.status !== "promoted" && (
          <span className="text-[12px] text-kumo-subtle">selected</span>
        )}
        {candidate.status === "promoted" && candidate.promotedGeneration !== null && (
          <span className="font-mono text-[12px]">
            {generation(candidate.baseGeneration)} → {generation(candidate.promotedGeneration)}
          </span>
        )}
        {tally.total > 0 && (
          <span className="ml-auto font-mono text-[12px] text-kumo-subtle tabular-nums">
            {formatNumber(tally.met)} / {formatNumber(tally.total)} required checks pass
          </span>
        )}
      </div>
      <p className="max-w-[760px] text-[13px] text-pretty">{reason}</p>
    </div>
  );
}
Leader.displayName = "Leader";

function OtherCandidate({ item }: { item: Item }) {
  const { candidate } = item;
  const selection = candidate.selection;
  const reason =
    selection && selection.winnerCandidateId !== candidate.id
      ? `Not selected: ${selection.reason}`
      : candidateSentence(item.label, candidate, item.rows);
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-kumo-rule py-2 text-[13px]">
      <Link
        to="/candidates/$candidateId"
        params={{ candidateId: candidate.id }}
        className="font-semibold hover:underline"
      >
        {item.label}
      </Link>
      <span className="min-w-0 truncate text-kumo-subtle" title={reason}>
        {reason}
      </span>
      <StatusPill status={candidate.status} />
    </li>
  );
}
OtherCandidate.displayName = "OtherCandidate";
