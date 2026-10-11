import { useUser } from "@clerk/tanstack-react-start";
import { Button } from "@cloudflare/kumo";
import { ArrowRight, CheckCircle, RocketLaunch } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  type ApprovalWithName,
  type CandidateDetail,
  promoteCandidate,
  type Release,
} from "../lib/api";
import { generation, timeAgo } from "../lib/format";
import { ApprovalDialog } from "./candidate/approval-dialog";
import { Banner } from "./candidate/banner";
import { type CheckRow, gateRule, shortHash } from "./candidate/model";
import { Mono } from "./ui/mono";
import { StatusPill } from "./ui/status-pill";

/**
 * Human gate and promotion for one Candidate (AGENTS.md sections 36, 38.4). The buttons only send
 * a request: the API takes the approver from the session, and the integration Worker plus
 * ProjectRootDO re-check every precondition. A disabled button here is a hint, not the gate.
 * Feedback is optimistic but honest (DESIGN.md 10): progress while the request runs, success only
 * after the compare-and-swap returns.
 */
export function CandidatePromotion({
  candidate,
  label,
  rows,
  riskTier,
}: {
  candidate: CandidateDetail;
  label: string;
  rows: CheckRow[];
  riskTier: string | null | undefined;
}) {
  const queryClient = useQueryClient();
  const { user } = useUser();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [decided, setDecided] = useState<"approve" | "reject" | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["candidate", candidate.id] }),
      queryClient.invalidateQueries({ queryKey: ["candidates", candidate.changeId] }),
    ]);
  const promote = useMutation({
    mutationFn: () => promoteCandidate({ data: candidate.id }),
    onSettled: refresh,
  });

  const { approval } = candidate;
  const verified = candidate.status === "verified" && candidate.gate?.promotable === true;
  const awaitingApproval = verified && candidate.approvalRequired && !approval;
  const canPromote = verified && (!candidate.approvalRequired || approval?.decision === "granted");
  const from = generation(candidate.baseGeneration);
  const to = generation(candidate.promotedGeneration ?? candidate.baseGeneration + 1);
  const rule = gateRule(candidate, riskTier);
  const promoted = promote.data;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="grid gap-1">
          <p className="flex items-center gap-2 font-mono text-[20px] font-semibold tabular-nums">
            <span>{from}</span>
            <ArrowRight size={16} aria-label="to" className="text-kumo-subtle" />
            <span className={candidate.status === "promoted" ? "" : "text-kumo-subtle"}>{to}</span>
          </p>
          <p className="max-w-[760px] text-[13px] text-pretty">{rule}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {awaitingApproval && (
            <>
              <Button variant="primary" icon={CheckCircle} onClick={() => setDialogOpen(true)}>
                Review and approve
              </Button>
              <Button variant="secondary" onClick={() => setDialogOpen(true)}>
                Reject
              </Button>
            </>
          )}
          {canPromote && !promoted && (
            <Button
              variant="primary"
              icon={RocketLaunch}
              loading={promote.isPending}
              onClick={() => promote.mutate()}
            >
              Promote {from} → {to}
            </Button>
          )}
        </div>
      </div>

      {approval && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-kumo-rule py-2 text-[13px]">
          <StatusPill status={approval.decision === "granted" ? "approved" : "rejected"} />
          <span>
            {approval.decision === "granted" ? "Approved" : "Rejected"} by{" "}
            <ApproverName approval={approval} me={user ? `usr_${user.id}` : null} />{" "}
            {timeAgo(approval.createdAt)} for tree <Mono>{shortHash(approval.candidateTree)}</Mono>{" "}
            under <Mono>{approval.policyVersion}</Mono>
          </span>
          {approval.reason && <span className="text-kumo-subtle">· {approval.reason}</span>}
        </div>
      )}

      {decided && !approval && (
        <Banner family="progress" title="Recording the decision">
          The decision was accepted. Refreshing the Candidate to show it.
        </Banner>
      )}

      {promote.isPending && (
        <Banner family="progress" title={`Promoting ${from} → ${to}`}>
          ProjectRootDO checks every precondition, runs the compare-and-swap, then syncs the
          canonical source. Waiting for the result.
        </Banner>
      )}
      {promote.isError && (
        <Banner
          family="danger"
          title="Promotion did not happen"
          action={
            <Button
              size="sm"
              variant="secondary"
              className="ring-current"
              onClick={() => promote.mutate()}
            >
              Retry
            </Button>
          }
        >
          {promote.error.message} The Canonical Generation did not change.
        </Banner>
      )}
      {promoted && (
        <Banner
          family="success"
          title={`Promoted · ${generation(promoted.fromGeneration)} → ${generation(promoted.generation)}`}
        >
          {promoted.alreadyPromoted
            ? "This Candidate was already promoted; the generation did not advance twice."
            : "The compare-and-swap succeeded. The Canonical Generation advanced once."}{" "}
          Tree <Mono>{shortHash(promoted.treeSha)}</Mono>.
        </Banner>
      )}
      {promoted && !promoted.sourceSynced && (
        <Banner
          family="attention"
          title="Source sync did not finish"
          action={
            <Button
              size="sm"
              variant="secondary"
              className="ring-current"
              loading={promote.isPending}
              onClick={() => promote.mutate()}
            >
              Retry sync
            </Button>
          }
        >
          {generation(promoted.generation)} is canonical, but the canonical source was not updated.
          Retry is safe: the generation does not advance twice.
        </Banner>
      )}

      {!promoted && candidate.status === "promoted" && (
        <p className="text-[13px]">
          Canonical Generation advanced {from} → {to}. The decision and Evidence stay on record.
        </p>
      )}
      {candidate.status === "promoted" && candidate.release && (
        <ReleaseStatus release={candidate.release} />
      )}
      {candidate.status === "stale" && (
        <p className="text-[13px] text-pretty">
          {candidate.statusReason ?? "The canonical state moved."} A stale Candidate cannot promote.
          Compose a new Candidate on the current generation.
        </p>
      )}
      {!verified && !["promoted", "stale"].includes(candidate.status) && !approval && (
        <p className="text-[13px] text-kumo-subtle">
          Promotion opens after every required check passes with supporting Evidence.
        </p>
      )}
      {verified && candidate.approvalRequired && approval?.decision === "rejected" && (
        <p className="text-[13px] text-kumo-subtle">
          A rejected Candidate cannot promote. The first decision is final.
        </p>
      )}

      {awaitingApproval && (
        <ApprovalDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          candidate={candidate}
          label={label}
          rows={rows}
          rule={rule}
          onDecided={(decision) => {
            setDecided(decision);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * The approver as a person: their email from the API, "you" when it is the signed-in user (the
 * API maps a Clerk user to `usr_<clerk id>`), else the internal ID in mono.
 */
function ApproverName({ approval, me }: { approval: ApprovalWithName; me: string | null }) {
  if (approval.approverUserId === me) {
    return <span title={approval.approverUserId}>you</span>;
  }
  if (approval.approverName) {
    return <span title={approval.approverUserId}>{approval.approverName}</span>;
  }
  return <Mono>{approval.approverUserId}</Mono>;
}
ApproverName.displayName = "ApproverName";

/**
 * Release of the promoted generation (AGENTS.md sections 21.3, 42.10; ADR 0020). The integration
 * Worker moves the live app's production pointer to the promoted commit and runs the smoke check. A failed release never moves the generation back: recovery is a new promotion.
 */
function ReleaseStatus({ release }: { release: Release }) {
  const gen = generation(release.generation);
  const commit = <Mono>{shortHash(release.commit)}</Mono>;
  if (release.status === "queued" || release.status === "building") {
    return (
      <Banner family="progress" title={`Release: building ${gen}`}>
        Releasing commit {commit} to the live app. The smoke check runs after the production pointer
        moves.
      </Banner>
    );
  }
  if (release.status === "deployed") {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-kumo-rule py-2 text-[13px]">
        <StatusPill status="deployed" />
        <span>
          Release: {gen} deployed
          {release.versionId ? (
            <>
              {" "}
              as version <Mono>{release.versionId.slice(0, 8)}</Mono>
            </>
          ) : null}
          {release.finishedAt ? ` ${timeAgo(release.finishedAt)}` : ""}. Smoke check passed.
        </span>
      </div>
    );
  }
  if (release.status === "superseded") {
    return (
      <p className="text-[13px] text-kumo-subtle">
        Release of {gen} was superseded: a newer generation was promoted before it deployed.
      </p>
    );
  }
  return (
    <Banner
      family="danger"
      title={
        release.status === "smoke_failed"
          ? `Release: ${gen} failed its smoke check`
          : `Release: ${gen} did not deploy`
      }
    >
      {release.failureReason ?? "No reason was recorded."} {gen} stays canonical; recover with a new
      promotion.
    </Banner>
  );
}
ReleaseStatus.displayName = "ReleaseStatus";
