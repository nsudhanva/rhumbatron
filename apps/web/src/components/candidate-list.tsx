import { Badge, Button, LayerCard, Text } from "@cloudflare/kumo";
import { GitFork } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type CandidateDetail, createCandidate } from "../lib/api";

const STATUS: Record<
  CandidateDetail["status"],
  "success" | "error" | "warning" | "info" | "secondary"
> = {
  composing: "info",
  composed: "info",
  verifying: "info",
  verified: "success",
  promoted: "success",
  rejected: "error",
  stale: "warning",
};

/** Candidate futures of one Change (AGENTS.md section 38.2). Evidence lives on the Candidate page. */
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
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center gap-2 px-5 py-2.5">
        <Text as="h2" variant="heading3">
          Candidates
        </Text>
        {canCompose && (
          <Button
            className="ml-auto"
            size="sm"
            icon={GitFork}
            loading={compose.isPending}
            onClick={() => compose.mutate()}
          >
            Verify a Candidate
          </Button>
        )}
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-2 px-5 py-4">
        {compose.isError && <Text variant="error">{compose.error.message}</Text>}
        {candidates.length === 0 ? (
          <Text variant="secondary">
            No Candidate yet. A Candidate composes the proposed ChangeSets and runs the required
            checks in the Sandbox.
          </Text>
        ) : (
          candidates.map((c) => (
            <Link
              key={c.id}
              to="/candidates/$candidateId"
              params={{ candidateId: c.id }}
              className="flex flex-wrap items-center gap-2 rounded-md border border-kumo-line px-3 py-2 text-sm hover:bg-kumo-tint"
            >
              <span className="font-mono text-xs">{c.id}</span>
              <Badge variant={STATUS[c.status]}>{c.status}</Badge>
              <span className="text-kumo-subtle">
                {c.changeSetIds.length} ChangeSet{c.changeSetIds.length === 1 ? "" : "s"}
              </span>
              {c.gate && (
                <span className="ml-auto text-kumo-subtle">
                  {c.gate.promotable ? "promotable" : `${c.gate.gaps.length} gap(s)`}
                </span>
              )}
            </Link>
          ))
        )}
      </LayerCard.Primary>
    </LayerCard>
  );
}
