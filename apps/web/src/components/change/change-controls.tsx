import { Button, Input } from "@cloudflare/kumo";
import { RocketLaunch } from "@phosphor-icons/react";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { cancelChange, promoteCandidate, raiseChangeBudget } from "../../lib/api";
import { formatUsd, generation } from "../../lib/format";
import { SectionError } from "../project/feedback";

/**
 * A person's commands on one Change. The API owns every rule;
 * these controls only send the request and refresh the Change reads.
 */

/** Statuses the API can cancel from: before promotion starts (integration change-status.ts). */
const CANCELLABLE = new Set([
  "proposed",
  "created",
  "compiling",
  "running",
  "verifying",
  "awaiting_approval",
  "budget_blocked",
  "awaiting_choice",
  "queued",
]);

function useRefreshChange(changeId: string, candidateId?: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      ...["change", "tasks", "candidates"].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key, changeId] }),
      ),
      ...(candidateId
        ? [queryClient.invalidateQueries({ queryKey: ["candidate", candidateId] })]
        : []),
    ]);
}

/**
 * Ship: promote one verified Candidate from the Change page. The same API call as Promote on the
 * Candidate page (`POST /v1/candidates/:id/promote`): the API checks the role, and the integration
 * Worker plus ProjectRootDO re-check every precondition and run the compare-and-swap. The shared
 * mutation key shows a running ship on both buttons (header and Needs attention).
 */
export function ShipCandidate({
  changeId,
  candidateId,
  baseGeneration,
}: {
  changeId: string;
  candidateId: string;
  baseGeneration: number;
}) {
  const refresh = useRefreshChange(changeId, candidateId);
  const ship = useMutation({
    mutationKey: ["promote", candidateId],
    mutationFn: () => promoteCandidate({ data: candidateId }),
    onSettled: refresh,
  });
  const busy = useIsMutating({ mutationKey: ["promote", candidateId] }) > 0;
  const route = `${generation(baseGeneration)} → ${generation(baseGeneration + 1)}`;
  return (
    <>
      {ship.isError && (
        <span role="alert" className="text-[13px] font-semibold text-kumo-danger">
          Not shipped: {ship.error.message}
        </span>
      )}
      <Button
        variant="primary"
        icon={RocketLaunch}
        loading={busy}
        disabled={ship.isSuccess || (busy && !ship.isPending)}
        onClick={() => ship.mutate()}
      >
        {ship.isSuccess ? `Shipped ${route}` : `Ship ${route}`}
      </Button>
    </>
  );
}
ShipCandidate.displayName = "ShipCandidate";

/** Page action: two clicks, so one stray click never cancels a Change. */
export function CancelChange({ changeId, status }: { changeId: string; status: string }) {
  const [confirming, setConfirming] = useState(false);
  const refresh = useRefreshChange(changeId);
  const cancel = useMutation({
    mutationFn: () => cancelChange({ data: changeId }),
    onSettled: () => {
      setConfirming(false);
      return refresh();
    },
  });
  if (!CANCELLABLE.has(status)) return null;
  // A request still waiting for review is withdrawn, not cancelled: nothing ran yet.
  const proposed = status === "proposed";
  if (!confirming) {
    return (
      <>
        {cancel.isError && (
          <span className="text-[13px] font-semibold text-kumo-danger">{cancel.error.message}</span>
        )}
        <Button variant="secondary" onClick={() => setConfirming(true)}>
          {proposed ? "Withdraw request" : "Cancel change"}
        </Button>
      </>
    );
  }
  return (
    <>
      {!cancel.isPending && (
        <Button variant="ghost" onClick={() => setConfirming(false)}>
          {proposed ? "Keep it" : "Keep running"}
        </Button>
      )}
      <Button variant="secondary" loading={cancel.isPending} onClick={() => cancel.mutate()}>
        {proposed ? "Confirm withdraw" : "Confirm cancel"}
      </Button>
    </>
  );
}
CancelChange.displayName = "CancelChange";

/** A person raises the budget here; shown only while a budget limit blocks the Change. */
export function RaiseBudget({ changeId, budgetUsd }: { changeId: string; budgetUsd: number }) {
  const [budget, setBudget] = useState(String(Math.min(100, Math.max(1, budgetUsd * 2))));
  const next = Number(budget);
  const [invalid, setInvalid] = useState(false);
  const refresh = useRefreshChange(changeId);
  const raise = useMutation({
    mutationFn: () => raiseChangeBudget({ data: { changeId, budgetUsd: next } }),
    onSettled: refresh,
  });
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const ok = next >= budgetUsd && next <= 100;
        setInvalid(!ok);
        if (ok) raise.mutate();
      }}
    >
      <p className="text-[13px] font-semibold text-accent-700">
        Blocked: a budget limit stopped new model work at {formatUsd(budgetUsd)}. Raise the budget
        to resume the ready Tasks.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="max-w-56">
          <Input
            label="New budget (USD)"
            type="number"
            min={budgetUsd}
            max={100}
            step={0.1}
            className="font-mono"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            required
          />
        </div>
        <Button type="submit" variant="secondary" loading={raise.isPending}>
          Raise budget
        </Button>
      </div>
      {invalid && (
        <p role="alert" className="text-[12px] font-semibold text-kumo-danger">
          Enter a budget from {formatUsd(budgetUsd)} to $100.00. A budget can only go up.
        </p>
      )}
      {raise.isError && (
        <SectionError message={`The budget was not raised. ${raise.error.message}`} />
      )}
    </form>
  );
}
RaiseBudget.displayName = "RaiseBudget";
