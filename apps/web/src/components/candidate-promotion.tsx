import { Badge, Button, Input, Text } from "@cloudflare/kumo";
import { ArrowRight, CheckCircle, Prohibit, RocketLaunch } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type CandidateDetail, decideApproval, promoteCandidate } from "../lib/api";
import { generation, timeAgo } from "../lib/format";

/**
 * Human gate and promotion for one Candidate (AGENTS.md sections 36, 38.4). The buttons only send
 * a request: the API takes the approver from the session, and the integration Worker plus
 * ProjectRootDO re-check every precondition. A disabled button here is a hint, not the gate.
 */
export function CandidatePromotion({ candidate }: { candidate: CandidateDetail }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["candidate", candidate.id] }),
      queryClient.invalidateQueries({ queryKey: ["candidates", candidate.changeId] }),
    ]);
  const decide = useMutation({
    mutationFn: (decision: "approve" | "reject") =>
      decideApproval({
        data: {
          changeId: candidate.changeId,
          candidateId: candidate.id,
          decision,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      }),
    onSettled: refresh,
  });
  const promote = useMutation({
    mutationFn: () => promoteCandidate({ data: candidate.id }),
    onSettled: refresh,
  });

  const { approval } = candidate;
  const verified = candidate.status === "verified" && candidate.gate?.promotable === true;
  const awaitingApproval = verified && candidate.approvalRequired && !approval;
  const canPromote = verified && (!candidate.approvalRequired || approval?.decision === "granted");
  const next = generation(candidate.baseGeneration + 1);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="secondary">{generation(candidate.baseGeneration)}</Badge>
        <ArrowRight size={14} className="text-kumo-subtle" />
        <Badge variant={candidate.status === "promoted" ? "success" : "secondary"}>
          {candidate.promotedGeneration === null ? next : generation(candidate.promotedGeneration)}
        </Badge>
        <span className="text-kumo-subtle">
          {candidate.approvalRequired ? "Human approval required by policy" : "No human gate"}
        </span>
      </div>

      {approval && (
        <Text variant="secondary">
          {approval.decision === "granted" ? (
            <CheckCircle size={16} weight="fill" className="mr-1 inline text-kumo-success" />
          ) : (
            <Prohibit size={16} weight="fill" className="mr-1 inline text-kumo-danger" />
          )}
          {approval.decision === "granted" ? "Approved" : "Rejected"} by{" "}
          <span className="font-mono text-xs">{approval.approverUserId}</span>{" "}
          {timeAgo(approval.createdAt)} for tree{" "}
          <span className="font-mono text-xs">{approval.candidateTree.slice(0, 12)}</span>
          {approval.reason ? `: ${approval.reason}` : ""}
        </Text>
      )}

      {candidate.status === "promoted" && (
        <Text>
          Promoted. Canonical Generation advanced {generation(candidate.baseGeneration)} →{" "}
          {generation(candidate.promotedGeneration ?? 0)}.
        </Text>
      )}
      {candidate.status === "stale" && (
        <Text variant="secondary">
          Stale: {candidate.statusReason ?? "the canonical state moved."} Verify a new Candidate on
          the current generation.
        </Text>
      )}
      {!verified && !["promoted", "stale"].includes(candidate.status) && !approval && (
        <Text variant="secondary">Promotion opens after every required check passes.</Text>
      )}

      {awaitingApproval && (
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <Input
            label="Reason (optional)"
            value={reason}
            maxLength={1000}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button
            variant="primary"
            icon={CheckCircle}
            loading={decide.isPending && decide.variables === "approve"}
            disabled={decide.isPending}
            onClick={() => decide.mutate("approve")}
          >
            Approve
          </Button>
          <Button
            variant="destructive"
            icon={Prohibit}
            loading={decide.isPending && decide.variables === "reject"}
            disabled={decide.isPending}
            onClick={() => decide.mutate("reject")}
          >
            Reject
          </Button>
        </div>
      )}
      {decide.isError && <Text variant="error">{decide.error.message}</Text>}

      {canPromote && (
        <div>
          <Button
            variant="primary"
            icon={RocketLaunch}
            loading={promote.isPending}
            onClick={() => promote.mutate()}
          >
            Promote to {next}
          </Button>
        </div>
      )}
      {promote.isError && <Text variant="error">{promote.error.message}</Text>}
      {promote.data && !promote.data.sourceSynced && (
        <Text variant="secondary">
          {generation(promote.data.generation)} is canonical, but the source sync did not finish.
          Promote again to retry it; the generation does not advance twice.
        </Text>
      )}
    </div>
  );
}
