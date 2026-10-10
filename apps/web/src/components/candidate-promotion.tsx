import { useUser } from "@clerk/tanstack-react-start";
import { Button } from "@cloudflare/kumo";
import { ArrowRight, CheckCircle, HandPalm, RocketLaunch } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  type ApprovalWithName,
  type CandidateDetail,
  promoteCandidate,
  type Release,
} from "../lib/api";
import { generation, generationCode, timeAgo } from "../lib/format";
import { ApprovalDialog } from "./candidate/approval-dialog";
import { Banner } from "./candidate/banner";
import { type CheckRow, gateRule, shortHash } from "./candidate/model";
import { TechnicalDetails } from "./candidate/technical-details";
import { KeyValue } from "./ui/key-value";
import { Mono } from "./ui/mono";
import { StatusPill } from "./ui/status-pill";

/**
 * "Your approval and shipping" for one version (AGENTS.md sections 36, 38.4; spec 7.4 steps 4-5).
 * The buttons only send a request: the API takes the approver from the session, and the server
 * re-checks every condition before the release advances. A disabled button here is a hint, not
 * the gate. Feedback is honest: progress while the request runs, success only after it returns.
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
  const fromGen = candidate.baseGeneration;
  const toGen = candidate.promotedGeneration ?? candidate.baseGeneration + 1;
  const from = generation(fromGen);
  const to = generation(toGen);
  const rule = gateRule(candidate, riskTier);
  const promoted = promote.data;
  const shipped = candidate.status === "promoted" || !!promoted;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="grid gap-1">
          <p className="flex items-center gap-2 text-[16px] font-semibold">
            <span>{from}</span>
            <ArrowRight size={16} aria-label="to" className="text-kumo-subtle" />
            <span className={shipped ? "" : "text-kumo-subtle"}>{to}</span>
          </p>
          <p className="max-w-[760px] text-[14px] text-pretty">{rule}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {awaitingApproval && (
            <>
              <Button variant="primary" icon={HandPalm} onClick={() => setDialogOpen(true)}>
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
              Ship {to}
            </Button>
          )}
        </div>
      </div>

      {approval && (
        <div className="grid gap-1 border-y border-kumo-rule py-2 text-[14px]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {approval.decision === "granted" ? (
              <StatusPill status="approved" />
            ) : (
              <StatusPill status="rejected" label="Rejected" />
            )}
            <span>
              {approval.decision === "granted" ? "Approved" : "Rejected"} by{" "}
              <ApproverName approval={approval} me={user ? `usr_${user.id}` : null} />{" "}
              {timeAgo(approval.createdAt)}
              {approval.reason ? `: ${approval.reason}` : ""}
            </span>
          </div>
          <TechnicalDetails>
            <KeyValue
              items={[
                { label: "Approved tree", value: approval.candidateTree, mono: true },
                { label: "Policy", value: approval.policyVersion, mono: true },
              ]}
            />
          </TechnicalDetails>
        </div>
      )}

      {decided && !approval && !promote.isPending && !promoted && (
        <Banner family="progress" title="Saving your decision">
          Your decision was accepted. Refreshing this version to show it.
        </Banner>
      )}

      {promote.isPending && (
        <Banner family="progress" title={`Shipping ${to}...`}>
          Checking every condition, saving the release, then syncing the code.
        </Banner>
      )}
      {promote.isError && (
        <Banner
          family="danger"
          title="Shipping failed"
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
          {promote.error.message.replace(/\.?$/, ".")} Nothing changed in the live release.
        </Banner>
      )}
      {promoted && (
        <Banner
          family="success"
          title={`Shipped: ${generation(promoted.fromGeneration)} → ${generation(promoted.generation)}`}
        >
          {promoted.alreadyPromoted
            ? "This version was already shipped; the release did not advance twice."
            : `${label} is now ${generation(promoted.generation)}.`}
          <TechnicalDetails className="pt-1">
            <KeyValue
              items={[
                {
                  label: "Transition",
                  value: `${generationCode(promoted.fromGeneration)} → ${generationCode(promoted.generation)}`,
                  mono: true,
                },
                { label: "Tree", value: promoted.treeSha, mono: true },
                { label: "Source commit", value: promoted.sourceCommit, mono: true },
              ]}
            />
          </TechnicalDetails>
        </Banner>
      )}
      {promoted && !promoted.sourceSynced && (
        <Banner
          family="attention"
          title="Release saved; code copy did not finish"
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
          {generation(promoted.generation)} is saved, but its code was not copied yet. Retrying is
          safe: the release does not advance twice.
        </Banner>
      )}

      {!promoted && candidate.status === "promoted" && (
        <p className="flex items-center gap-2 text-[14px]">
          <CheckCircle size={16} className="shrink-0 text-kumo-success" aria-hidden />
          Shipped: {from} → {to}.
        </p>
      )}
      {candidate.status === "promoted" && candidate.release && (
        <ReleaseStatus release={candidate.release} />
      )}
      {candidate.status === "stale" && (
        <p className="text-[14px] text-pretty">
          This version is out of date because another change shipped first, so it can't ship. Run
          the checks again to build it on the current release.
        </p>
      )}
      {!verified && !["promoted", "stale"].includes(candidate.status) && !approval && (
        <p className="text-[14px] text-kumo-subtle">
          Shipping opens after every required check passes.
        </p>
      )}
      {verified && candidate.approvalRequired && approval?.decision === "rejected" && (
        <p className="text-[14px] text-kumo-subtle">
          A rejected version can't ship. The first decision is final.
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
            // "Approve and ship": the approval is recorded, so ship right away.
            if (decision === "approve") promote.mutate();
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
 * Deployment of a shipped release (AGENTS.md sections 21.3, 37, 42.10; ADR 0018). The release is
 * built from the saved code, deployed, then smoke-checked. A failed deployment never moves the
 * release back: the previous app stays live and recovery is a new ship.
 */
function ReleaseStatus({ release }: { release: Release }) {
  const gen = generation(release.generation);
  const details = (
    <TechnicalDetails className="pt-1">
      <KeyValue
        items={[
          { label: "Worker", value: release.workerName, mono: true },
          { label: "Commit", value: shortHash(release.commit), mono: true },
          { label: "Version", value: release.versionId, mono: true },
          { label: "Release", value: generationCode(release.generation), mono: true },
        ]}
      />
    </TechnicalDetails>
  );
  if (release.status === "queued" || release.status === "building") {
    return (
      <Banner family="progress" title={`Deploying ${gen}`}>
        Building the release, then running a smoke check.
        {details}
      </Banner>
    );
  }
  if (release.status === "deployed") {
    return (
      <div className="grid gap-1 border-y border-kumo-rule py-2 text-[14px]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusPill status="deployed" label="Live" />
          <span className="font-semibold">{gen} is live</span>
          {release.url && (
            <a
              href={release.url}
              target="_blank"
              rel="noreferrer"
              className="text-kumo-link underline-offset-2 hover:underline"
            >
              Open the app
            </a>
          )}
          {release.finishedAt && (
            <span className="text-[12px] text-kumo-subtle">
              deployed {timeAgo(release.finishedAt)}
            </span>
          )}
        </div>
        {details}
      </div>
    );
  }
  if (release.status === "superseded") {
    return (
      <p className="text-[14px] text-kumo-subtle">
        {gen} was replaced by a newer release before it deployed.
      </p>
    );
  }
  return (
    <Banner family="danger" title={`${gen} was saved but did not deploy`}>
      Your previous app is still live.
      {release.failureReason ? ` ${release.failureReason}` : ""}
      {details}
    </Banner>
  );
}
ReleaseStatus.displayName = "ReleaseStatus";
