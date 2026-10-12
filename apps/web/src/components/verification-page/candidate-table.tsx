import { cn } from "@cloudflare/kumo";
import { Link } from "@tanstack/react-router";
import { changeLabel, EMPTY, formatAge, generation } from "../../lib/format";
import { formatP95 } from "../candidate/model";
import { DataTable, RowLink, Td, Th, TitleCell, TRow } from "../ui/data-table";
import { FAMILY_TEXT, StatusPill } from "../ui/status-pill";
import { gateWords, type VerifiedCandidate } from "./model";

const linkClass =
  "relative z-10 text-kumo-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500";

/**
 * Recent Candidates (DESIGN.md 8.3 table): the whole row opens the Candidate; the Change and
 * Compare links sit above the row link. `#` matches the heat grid column index.
 */
export function CandidateTable({ items }: { items: VerifiedCandidate[] }) {
  return (
    <DataTable label="Recent Candidates" minWidth={980}>
      <thead>
        <tr>
          <Th numeric className="w-10">
            #
          </Th>
          <Th>Candidate</Th>
          <Th>Change</Th>
          <Th>Status</Th>
          <Th>Gate</Th>
          <Th numeric>p95</Th>
          <Th numeric>Age</Th>
          <Th>
            <span className="sr-only">Compare</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const { candidate, tally } = item;
          const overBudget = item.p95 !== null && item.budget !== null && item.p95 >= item.budget;
          const gateFamily =
            tally.failed.length > 0 ? "danger" : tally.gaps.length > 0 ? "attention" : null;
          return (
            <TRow key={candidate.id}>
              <Td numeric className="text-kumo-subtle">
                {item.gridIndex === null ? EMPTY : String(item.gridIndex).padStart(2, "0")}
              </Td>
              <Td className="max-w-56">
                <TitleCell
                  title={
                    <RowLink to="/candidates/$candidateId" params={{ candidateId: candidate.id }}>
                      {item.label}
                    </RowLink>
                  }
                  meta={`${candidate.id} · base ${generation(candidate.baseGeneration)}`}
                />
              </Td>
              <Td className="max-w-72">
                <div className="grid min-w-0">
                  <Link
                    to="/changes/$changeId"
                    params={{ changeId: candidate.changeId }}
                    title={item.change?.goal}
                    className={cn(linkClass, "truncate")}
                  >
                    {item.change ? changeLabel(item.change) : candidate.changeId}
                  </Link>
                  <span className="truncate font-mono text-[11px] text-kumo-subtle">
                    {candidate.changeId}
                    {item.change?.riskTier ? ` · risk ${item.change.riskTier}` : ""}
                  </span>
                </div>
              </Td>
              <Td>
                <StatusPill status={candidate.status} />
              </Td>
              <Td className="max-w-72">
                <span
                  className={cn(
                    "block truncate text-[12px]",
                    gateFamily && FAMILY_TEXT[gateFamily],
                  )}
                  title={gateWords(item)}
                >
                  {gateWords(item)}
                </span>
              </Td>
              <Td numeric className={overBudget ? "text-kumo-danger" : undefined}>
                {item.p95 === null ? EMPTY : formatP95(item.p95)}
              </Td>
              <Td numeric className="text-kumo-subtle">
                {formatAge(candidate.createdAt)}
              </Td>
              <Td>
                {item.siblings >= 2 ? (
                  <Link
                    to="/compare/$changeId"
                    params={{ changeId: candidate.changeId }}
                    className={cn(linkClass, "text-[12px] font-semibold whitespace-nowrap")}
                  >
                    Compare
                  </Link>
                ) : (
                  <span className="text-kumo-subtle">{EMPTY}</span>
                )}
              </Td>
            </TRow>
          );
        })}
      </tbody>
    </DataTable>
  );
}
CandidateTable.displayName = "CandidateTable";
