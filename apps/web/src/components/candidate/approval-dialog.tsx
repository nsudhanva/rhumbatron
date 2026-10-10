import { useUser } from "@clerk/tanstack-react-start";
import { Button, Dialog, InputArea } from "@cloudflare/kumo";
import {
  CheckCircle,
  Circle,
  RocketLaunch,
  WarningCircle,
  X,
  XCircle,
} from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { type CandidateDetail, decideApproval } from "../../lib/api";
import { generation, generationCode } from "../../lib/format";
import { KeyValue } from "../ui/key-value";
import { type CheckRow, criterion, p95Budget, requiredTally, verdictWord } from "./model";
import { TechnicalDetails } from "./technical-details";

/**
 * "Approve and ship" dialog (spec 6.2 P8, 7.4 step 4). It repeats what the person approves, the
 * rule that asks for a person, and an optional reason. It only records the decision; the caller
 * ships after `onDecided("approve")`. The API takes the approver from the session, so the browser
 * cannot name one. Outside clicks do not close the dialog while a decision is pending.
 */
export function ApprovalDialog({
  open,
  onOpenChange,
  candidate,
  label,
  rows,
  rule,
  onDecided,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidate: CandidateDetail;
  label: string;
  rows: CheckRow[];
  rule: string;
  onDecided: (decision: "approve" | "reject") => void;
}) {
  const { user } = useUser();
  const approver = user?.fullName || user?.primaryEmailAddress?.emailAddress || "you";
  const [reason, setReason] = useState("");
  // A rejection needs a reason so the people who built the version learn why.
  const [askReason, setAskReason] = useState(false);
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
    onSuccess: (_result, decision) => {
      setReason("");
      setAskReason(false);
      onOpenChange(false);
      onDecided(decision);
    },
  });

  const required = rows.filter((r) => r.required);
  const tally = requiredTally(rows);
  const budget = p95Budget(candidate);
  const summary = [
    label,
    `${tally.met} of ${tally.total} checks passed`,
    `Based on ${generation(candidate.baseGeneration)}`,
  ].join(" · ");

  const reject = () => {
    if (!reason.trim()) {
      setAskReason(true);
      return;
    }
    decide.mutate("reject");
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!decide.isPending) onOpenChange(next);
      }}
      disablePointerDismissal
    >
      <Dialog size="lg" className="grid max-h-[calc(100dvh-32px)] gap-4 overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3">
          <Dialog.Title className="text-[20px] leading-tight font-semibold">
            Approve and ship {label}?
          </Dialog.Title>
          <Dialog.Close
            aria-label="Close"
            title="Close"
            disabled={decide.isPending}
            className="-mt-1 -mr-1 grid size-7 place-items-center rounded-md text-kumo-subtle hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-accent-500"
          >
            <X size={16} aria-hidden />
          </Dialog.Close>
        </div>

        <div className="grid gap-2">
          <p className="text-[14px]">
            <span className="text-kumo-subtle">You are approving: </span>
            <span className="font-semibold">{summary}</span>
          </p>
          <Dialog.Description className="text-[14px] text-pretty">
            {rule} Shipping makes {label} the new release,{" "}
            {generation(candidate.baseGeneration + 1)}, and deploys it.
          </Dialog.Description>
        </div>

        <details className="rounded-lg border border-kumo-rule bg-kumo-elevated">
          <summary className="cursor-pointer px-3 py-2 text-[13px] font-semibold">
            See the {tally.total} required checks
          </summary>
          <ul className="grid border-t border-kumo-rule px-3 py-1">
            {required.map((row) => (
              <li
                key={row.checkId}
                className="flex items-start gap-2 border-b border-kumo-rule py-1.5 text-[13px] last:border-b-0"
              >
                {row.verdict === "pass" ? (
                  <CheckCircle size={16} className="mt-px shrink-0 text-kumo-success" aria-hidden />
                ) : row.verdict === "pending" ? (
                  <Circle size={16} className="mt-px shrink-0 text-kumo-subtle" aria-hidden />
                ) : row.verdict === "fail" ? (
                  <XCircle size={16} className="mt-px shrink-0 text-kumo-danger" aria-hidden />
                ) : (
                  <WarningCircle
                    size={16}
                    className="mt-px shrink-0 text-kumo-warning"
                    aria-hidden
                  />
                )}
                <span className="min-w-0">
                  {criterion(row, budget).title}
                  <span className="text-kumo-subtle"> · {verdictWord(row)}</span>
                </span>
              </li>
            ))}
          </ul>
        </details>

        <InputArea
          label={askReason ? "Why are you rejecting it?" : "Reason (optional)"}
          description={
            askReason
              ? "Add a reason, then press Reject again."
              : "Saved with your decision and shown on this version."
          }
          value={reason}
          maxLength={1000}
          onValueChange={setReason}
          minRows={2}
          autoResize
        />

        <TechnicalDetails>
          <KeyValue
            items={[
              { label: "Candidate", value: candidate.id, mono: true },
              { label: "Composed tree", value: candidate.composedTree, mono: true },
              {
                label: "Transition",
                value: `${generationCode(candidate.baseGeneration)} → ${generationCode(candidate.baseGeneration + 1)}`,
                mono: true,
              },
              { label: "Policy", value: candidate.plan?.policyVersion ?? null, mono: true },
            ]}
          />
          <p className="pt-1 text-kumo-subtle">Your decision applies only to this exact code.</p>
        </TechnicalDetails>

        {decide.isError && (
          <p role="alert" className="flex items-start gap-1.5 text-[13px] text-kumo-danger">
            <XCircle size={16} className="mt-px shrink-0" aria-hidden />
            {decide.error.message}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            icon={RocketLaunch}
            loading={decide.isPending && decide.variables === "approve"}
            disabled={decide.isPending}
            onClick={() => decide.mutate("approve")}
          >
            Approve and ship
          </Button>
          <Button
            variant="secondary"
            loading={decide.isPending && decide.variables === "reject"}
            disabled={decide.isPending}
            onClick={reject}
          >
            Reject
          </Button>
          <span className="ml-auto truncate text-[12px] text-kumo-subtle">
            Signed in as {approver}
          </span>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
ApprovalDialog.displayName = "ApprovalDialog";
