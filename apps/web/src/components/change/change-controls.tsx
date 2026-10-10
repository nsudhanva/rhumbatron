import { Button, Input } from "@cloudflare/kumo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { cancelChange, raiseChangeBudget } from "../../lib/api";
import { formatUsd } from "../../lib/format";
import { SectionError } from "../project/feedback";

/**
 * A person's commands on one Change (AGENTS.md sections 16.1 and 44). The API owns every rule;
 * these controls only send the request and refresh the Change reads.
 */

/** Statuses the API can cancel from: before promotion starts (integration change-status.ts). */
const CANCELLABLE = new Set([
  "created",
  "compiling",
  "running",
  "verifying",
  "awaiting_approval",
  "budget_blocked",
]);

function useRefreshChange(changeId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      ["change", "tasks", "candidates"].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key, changeId] }),
      ),
    );
}

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
  if (!confirming) {
    return (
      <>
        {cancel.isError && (
          <span className="text-[13px] font-semibold text-kumo-danger">{cancel.error.message}</span>
        )}
        <Button variant="secondary" onClick={() => setConfirming(true)}>
          Cancel change
        </Button>
      </>
    );
  }
  return (
    <>
      <Button variant="ghost" onClick={() => setConfirming(false)} disabled={cancel.isPending}>
        Keep running
      </Button>
      <Button variant="secondary" loading={cancel.isPending} onClick={() => cancel.mutate()}>
        Confirm cancel
      </Button>
    </>
  );
}
CancelChange.displayName = "CancelChange";

/** Section 44 rule 5: shown only while a budget limit blocks the Change. */
export function RaiseBudget({ changeId, budgetUsd }: { changeId: string; budgetUsd: number }) {
  const [budget, setBudget] = useState(String(Math.min(100, Math.max(1, budgetUsd * 2))));
  const next = Number(budget);
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
        raise.mutate();
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
        <Button
          type="submit"
          variant="secondary"
          loading={raise.isPending}
          disabled={!(next >= budgetUsd && next <= 100)}
        >
          Raise budget
        </Button>
      </div>
      {raise.isError && (
        <SectionError message={`The budget was not raised. ${raise.error.message}`} />
      )}
    </form>
  );
}
RaiseBudget.displayName = "RaiseBudget";
