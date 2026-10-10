import { useUser } from "@clerk/tanstack-react-start";
import { Button } from "@cloudflare/kumo";
import { HandPalm } from "@phosphor-icons/react";
import type { ApprovalWithName } from "../../lib/api";
import { plural, timeAgo } from "../../lib/format";
import { gateRule, requiredTally } from "../candidate/model";
import { isReady, type VersionView } from "./headline";
import type { FilesSummary } from "./model";

/**
 * Step 4, Your approval (docs/ux/research-2026-10-09.md 7.4, P8): skipped when the policy does
 * not ask for a person; an amber box with the reason and what is being approved while pending;
 * the decision once recorded. The API takes the approver from the session.
 */

/** "you" for the signed-in user (the API maps a Clerk user to `usr_<id>`), else the name. */
function useApproverName(approval: ApprovalWithName) {
  const { user } = useUser();
  if (user && approval.approverUserId === `usr_${user.id}`) return "you";
  return approval.approverName || "a teammate";
}

function Decision({ approval }: { approval: ApprovalWithName }) {
  const name = useApproverName(approval);
  if (approval.decision === "granted") {
    return (
      <p className="text-[14px]">
        Approved by {name} · {timeAgo(approval.createdAt)}
        {approval.reason ? <span className="text-kumo-subtle"> · {approval.reason}</span> : null}
      </p>
    );
  }
  return (
    <p className="text-[14px] text-kumo-danger">
      Rejected by {name}
      {approval.reason ? `: ${approval.reason}` : "."} This change does not ship.
    </p>
  );
}

export function ApprovalStep({
  version,
  riskTier,
  files,
  onReview,
  busy,
}: {
  version: VersionView | null;
  riskTier: string | null | undefined;
  files: FilesSummary | null;
  onReview: () => void;
  /** Approve-and-ship is running. */
  busy: boolean;
}) {
  if (version?.candidate.approval) return <Decision approval={version.candidate.approval} />;
  if (!version || (!isReady(version) && version.candidate.status !== "promoted")) {
    return <p className="text-[14px] text-kumo-subtle">Not yet.</p>;
  }
  if (!version.candidate.approvalRequired) {
    return (
      <p className="text-[14px] text-kumo-subtle">
        No approval needed for {riskTier ? `${riskTier} risk` : "this kind of"} changes.
      </p>
    );
  }
  const tally = requiredTally(version.rows);
  const summary = [
    version.label,
    `${tally.met} of ${tally.total} checks passed`,
    files ? `${plural(files.files.length, "file")} changed` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="grid gap-2 rounded-lg border border-kumo-warning bg-kumo-warning-tint p-4 text-[14px]">
      <p className="flex items-center gap-2 font-semibold">
        <HandPalm size={16} aria-hidden className="text-kumo-warning" />
        Needs your approval.
      </p>
      <p>{gateRule(version.candidate, riskTier)}</p>
      <p>You are approving: {summary}</p>
      <div>
        <Button variant="primary" loading={busy} onClick={onReview}>
          Review and approve
        </Button>
      </div>
    </div>
  );
}
ApprovalStep.displayName = "ApprovalStep";
