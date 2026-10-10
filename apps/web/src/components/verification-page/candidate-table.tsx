import { cn } from "@cloudflare/kumo";
import { Link } from "@tanstack/react-router";
import { EMPTY, formatAge, formatNumber, truncate } from "../../lib/format";
import { formatP95, versionWord } from "../candidate/model";
import { DataTable, RowLink, Td, Th, TRow } from "../ui/data-table";
import { StatusPill } from "../ui/status-pill";
import { checksWords, type VerifiedCandidate } from "./model";

const linkClass =
  "relative z-10 text-kumo-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500";

/**
 * Recent versions: the whole row opens the version; the change and Compare links sit above the
 * row link. Plain words only; IDs live on the version page under Technical details.
 */
export function CandidateTable({ items }: { items: VerifiedCandidate[] }) {
  return (
    <DataTable label="Recent versions" minWidth={820}>
      <thead>
        <tr>
          <Th>Change</Th>
          <Th>Version</Th>
          <Th>Status</Th>
          <Th>Required checks</Th>
          <Th numeric>Response time (p95)</Th>
          <Th numeric>Updated</Th>
          <Th>
            <span className="sr-only">Compare</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const { candidate, tally } = item;
          const overBudget = item.p95 !== null && item.budget !== null && item.p95 >= item.budget;
          const words = checksWords(item);
          return (
            <TRow key={candidate.id}>
              <Td className="max-w-72">
                <Link
                  to="/changes/$changeId"
                  params={{ changeId: candidate.changeId }}
                  title={item.change?.goal}
                  className={cn(linkClass, "block truncate")}
                >
                  {item.change ? truncate(item.change.goal, 64) : "Untitled change"}
                </Link>
              </Td>
              <Td>
                <RowLink
                  to="/candidates/$candidateId"
                  params={{ candidateId: candidate.id }}
                  className="font-semibold whitespace-nowrap"
                >
                  {item.label}
                </RowLink>
              </Td>
              <Td>
                <StatusPill status={candidate.status} label={versionWord(candidate.status)} />
              </Td>
              <Td className="max-w-64">
                <span
                  className={cn(
                    "block truncate text-[13px]",
                    tally.failed.length > 0
                      ? "text-kumo-danger"
                      : tally.gaps.length > 0 && "text-kumo-warning",
                  )}
                  title={words}
                >
                  {words}
                </span>
              </Td>
              <Td numeric className={overBudget ? "text-kumo-danger" : undefined}>
                {item.p95 === null ? EMPTY : formatP95(item.p95)}
              </Td>
              <Td numeric className="text-kumo-subtle">
                {formatAge(candidate.updatedAt)}
              </Td>
              <Td>
                {item.siblings >= 2 ? (
                  <Link
                    to="/compare/$changeId"
                    params={{ changeId: candidate.changeId }}
                    className={cn(linkClass, "text-[13px] whitespace-nowrap")}
                    title={`Compare ${formatNumber(item.siblings)} versions`}
                  >
                    Compare
                  </Link>
                ) : null}
              </Td>
            </TRow>
          );
        })}
      </tbody>
    </DataTable>
  );
}
CandidateTable.displayName = "CandidateTable";
