import { useUser } from "@clerk/tanstack-react-start";
import { Button, Dialog, InputArea } from "@cloudflare/kumo";
import { Check, Square, X } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { type CandidateDetail, decideApproval } from "../../lib/api";
import { formatMs, generation } from "../../lib/format";
import { KeyValue } from "../ui/key-value";
import {
  type CheckRow,
  criterion,
  formatP95,
  p95Budget,
  p95Of,
  REASON_WORDS,
  requiredTally,
} from "./model";

/**
 * Human gate (AGENTS.md sections 36 rule 4, 40.2; DESIGN.md 8.4, 9.14, 10 "Confirm decisions in
 * place"). The dialog shows the Evidence the decision rests on, the facts it binds to, and the
 * required-check checklist. The API takes the approver from the session; the browser cannot name
 * one. Outside clicks do not close the dialog while a decision is pending.
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
      onOpenChange(false);
      onDecided(decision);
    },
  });

  const required = rows.filter((r) => r.required);
  const tally = requiredTally(rows);
  const budget = p95Budget(candidate);
  const p95 = p95Of(candidate, rows);
  const evidenceLine = [
    `${tally.met} of ${tally.total} required checks pass with executable Evidence`,
    p95 !== null && budget !== null
      ? `p95 ${formatP95(p95)} against a ${formatMs(budget)} budget`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!decide.isPending) onOpenChange(next);
      }}
      disablePointerDismissal
    >
      <Dialog size="lg" className="grid max-h-[calc(100dvh-32px)] gap-4 overflow-y-auto p-4">
        <div className="flex items-start justify-between gap-3">
          <p className="type-kicker text-kumo-accent">
            Human gate · {candidate.plan?.policyVersion ?? "policy"}
          </p>
          <Dialog.Close
            aria-label="Close"
            title="Close"
            disabled={decide.isPending}
            className="-mt-1 -mr-1 grid size-7 place-items-center text-kumo-subtle hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-accent-500"
          >
            <X size={16} aria-hidden />
          </Dialog.Close>
        </div>
        <div className="grid gap-2">
          <Dialog.Title className="type-h4">Approve {label} for promotion</Dialog.Title>
          <Dialog.Description className="text-[14px] text-pretty">
            {rule} Your decision binds to the composed tree below. If the tree changes, the decision
            no longer applies.
          </Dialog.Description>
          <p className="text-[13px] text-kumo-subtle">{evidenceLine}.</p>
        </div>

        <div className="border-t-2 border-b border-t-kumo-divider border-b-kumo-rule py-3">
          <KeyValue
            items={[
              { label: "Candidate", value: candidate.id, mono: true },
              { label: "Composed tree", value: candidate.composedTree, mono: true },
              {
                label: "Transition",
                value: `${generation(candidate.baseGeneration)} → ${generation(candidate.baseGeneration + 1)}`,
                mono: true,
              },
              { label: "Policy", value: candidate.plan?.policyVersion ?? null, mono: true },
              { label: "Approver", value: `${approver} (signed in)` },
            ]}
          />
        </div>

        <div className="grid gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="type-label text-kumo-subtle">Required checks</p>
            <span className="font-mono text-[12px] tabular-nums">
              {tally.met} / {tally.total} met
            </span>
          </div>
          <ul className="grid">
            {required.map((row) => (
              <li
                key={row.checkId}
                className="flex items-start gap-2 border-b border-kumo-rule py-1.5 text-[13px] last:border-b-0"
              >
                {row.verdict === "pass" ? (
                  <Check
                    size={14}
                    weight="bold"
                    className="mt-0.5 shrink-0 text-kumo-success"
                    aria-hidden
                  />
                ) : row.verdict === "pending" ? (
                  <Square size={14} className="mt-0.5 shrink-0 text-kumo-divider" aria-hidden />
                ) : (
                  <X
                    size={14}
                    weight="bold"
                    className="mt-0.5 shrink-0 text-kumo-danger"
                    aria-hidden
                  />
                )}
                <span className="min-w-0">
                  <span className="sr-only">
                    {row.verdict === "pass"
                      ? "Met: "
                      : row.verdict === "pending"
                        ? "Pending: "
                        : "Not met: "}
                  </span>
                  {criterion(row, budget).title}
                  <span className="font-mono text-[11px] text-kumo-subtle"> · {row.checkId}</span>
                  {row.verdict !== "pass" && row.reason && (
                    <span className="text-kumo-subtle"> · {REASON_WORDS[row.reason]}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <InputArea
          label="Reason (optional)"
          description="Recorded with the decision and shown on the Candidate."
          value={reason}
          maxLength={1000}
          onValueChange={setReason}
          minRows={2}
          autoResize
        />

        {decide.isError && (
          <p role="alert" className="flex items-start gap-1.5 text-[12px] text-kumo-danger">
            <X size={14} className="mt-px shrink-0" aria-hidden />
            {decide.error.message}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            icon={Check}
            loading={decide.isPending && decide.variables === "approve"}
            disabled={decide.isPending}
            onClick={() => decide.mutate("approve")}
          >
            Approve
          </Button>
          <Button
            variant="secondary"
            loading={decide.isPending && decide.variables === "reject"}
            disabled={decide.isPending}
            onClick={() => decide.mutate("reject")}
          >
            Reject
          </Button>
          <span className="ml-auto truncate text-[12px] text-kumo-subtle">as {approver}</span>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
