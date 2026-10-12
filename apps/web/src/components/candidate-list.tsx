import { Button } from "@cloudflare/kumo";
import { GitFork } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type CandidateDetail, createCandidate } from "../lib/api";
import { formatAge, formatMs, formatNumber, generation } from "../lib/format";
import { candidateLabels } from "./candidate/model";
import { DataTable, RowLink, Td, Th, TitleCell, TRow } from "./ui/data-table";
import { EmptyState } from "./ui/empty-state";
import { Section } from "./ui/page";
import { StatusPill } from "./ui/status-pill";

/**
 * Candidate futures of one Change. Evidence lives on the Candidate page.
 * "Verify a Candidate" is the Change page's one primary action.
 */
export function CandidateList({
  changeId,
  candidates,
  canCompose,
}: {
  changeId: string;
  candidates: CandidateDetail[];
  canCompose: boolean;
}) {
  const queryClient = useQueryClient();
  const compose = useMutation({
    mutationFn: () => createCandidate({ data: changeId }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["candidates", changeId] }),
  });
  // Creation order, with the names the Candidate pages and activity view use.
  const ordered = [...candidates].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const names = candidateLabels(candidates);
  const verified = candidates.filter((c) => c.status === "verified" || c.status === "promoted");

  return (
    <Section
      label="Candidates"
      meta={
        <>
          {candidates.length > 0 && (
            <span className="font-mono tabular-nums">
              {formatNumber(verified.length)} / {formatNumber(candidates.length)} verified
            </span>
          )}
          {candidates.length >= 2 && (
            <Link
              to="/compare/$changeId"
              params={{ changeId }}
              className="font-semibold text-kumo-link hover:underline"
            >
              Compare candidates
            </Link>
          )}
          {canCompose && (
            <Button
              size="sm"
              variant="secondary"
              icon={GitFork}
              loading={compose.isPending}
              onClick={() => compose.mutate()}
            >
              Verify a Candidate
            </Button>
          )}
        </>
      }
    >
      {compose.isError && (
        <p className="bg-accent-100 px-3 py-2 text-[13px] font-semibold text-kumo-danger">
          {compose.error.message}
        </p>
      )}
      {ordered.length === 0 ? (
        <EmptyState
          what="No Candidate yet."
          how="A Candidate composes the proposed ChangeSets and runs the required checks in the Sandbox."
        />
      ) : (
        <DataTable label="Candidates" minWidth={720}>
          <thead>
            <tr>
              <Th>Candidate</Th>
              <Th>Status</Th>
              <Th numeric>ChangeSets</Th>
              <Th numeric>p95</Th>
              <Th>Gate</Th>
              <Th numeric>Updated</Th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((c) => (
              <TRow key={c.id}>
                <Td>
                  <TitleCell
                    title={
                      <RowLink to="/candidates/$candidateId" params={{ candidateId: c.id }}>
                        {names.get(c.id)}
                      </RowLink>
                    }
                    meta={`${c.id} · base ${generation(c.baseGeneration)}`}
                  />
                </Td>
                <Td>
                  <StatusPill status={c.status} />
                </Td>
                <Td numeric>{formatNumber(c.changeSetIds.length)}</Td>
                <Td numeric>{formatMs(c.gate?.p95Ms, 1)}</Td>
                <Td className="max-w-[320px]">
                  <Gate candidate={c} />
                </Td>
                <Td numeric className="text-kumo-subtle">
                  {formatAge(c.updatedAt)}
                </Td>
              </TRow>
            ))}
          </tbody>
        </DataTable>
      )}
    </Section>
  );
}

function Gate({ candidate }: { candidate: CandidateDetail }) {
  if (candidate.status === "promoted" && candidate.promotedGeneration !== null) {
    return (
      <span className="text-[12px]">
        Promoted to <span className="font-mono">{generation(candidate.promotedGeneration)}</span>
      </span>
    );
  }
  if (candidate.status === "rejected") {
    return (
      <span
        className="block truncate text-[12px] text-kumo-danger"
        title={candidate.statusReason ?? undefined}
      >
        {candidate.statusReason ?? "Rejected"}
      </span>
    );
  }
  if (!candidate.gate) return <span className="text-[12px] text-kumo-subtle">Verifying</span>;
  if (candidate.gate.promotable) {
    return <span className="text-[12px] font-semibold text-kumo-success">Promotable</span>;
  }
  const gaps = candidate.gate.gaps;
  return (
    <span
      className="block truncate text-[12px] text-kumo-warning"
      title={gaps.map((g) => `${g.checkId}: ${g.reason}`).join("\n")}
    >
      {formatNumber(gaps.length)} {gaps.length === 1 ? "gap" : "gaps"}
      {gaps[0] ? ` · ${gaps[0].checkId}` : ""}
    </span>
  );
}
