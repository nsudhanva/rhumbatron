import { Button, Input } from "@cloudflare/kumo";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { MONTHLY_BUDGET_LIMITS } from "../../lib/api-budget";
import { formatUsd } from "../../lib/format";
import { CapMeter } from "../costs-page/charts";
import { formatCost } from "../costs-page/cost-format";
import { SectionError } from "../project/feedback";

/**
 * A monthly budget field (docs/operations/costs.md, "Budget scopes"): the Project monthly budget
 * in Settings and the personal one on the Account page. $1 to $100, or none. This month's spend
 * shows under it, on a meter when a budget is set.
 */
export function MonthlyBudgetForm<T>({
  label,
  description,
  capUsd,
  spentUsd,
  spentLabel,
  save,
  onSaved,
}: {
  label: string;
  description: string;
  /** Null: no monthly budget is set. */
  capUsd: number | null;
  spentUsd: number;
  /** "Spent this month", or with the month name. */
  spentLabel: string;
  save: (monthlyBudgetUsd: number | null) => Promise<T>;
  onSaved: (result: T) => void;
}) {
  const { min, max } = MONTHLY_BUDGET_LIMITS;
  const stored = capUsd === null ? "" : String(capUsd);
  const [value, setValue] = useState(stored);
  useEffect(() => setValue(stored), [stored]);
  const amount = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(amount) && amount >= min && amount <= max;
  const unchanged = valid && amount === capUsd;
  const [invalid, setInvalid] = useState(false);
  const mutation = useMutation({ mutationFn: save, onSuccess: onSaved });

  return (
    <form
      className="grid gap-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) {
          setInvalid(true);
          return;
        }
        if (!unchanged) mutation.mutate(Math.round(amount * 100) / 100);
      }}
    >
      <div className="max-w-56">
        <Input
          label={label}
          description={`${description} ${formatUsd(min)} to ${formatUsd(max)}.`}
          type="number"
          min={min}
          max={max}
          step={1}
          className="font-mono"
          placeholder="None"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
            mutation.reset();
          }}
          aria-invalid={invalid || undefined}
        />
      </div>
      {capUsd === null ? (
        <p className="text-[12px] text-kumo-subtle">
          {spentLabel}: <span className="font-mono tabular-nums">{formatCost(spentUsd)}</span>. No
          monthly budget is set.
        </p>
      ) : (
        <CapMeter
          className="max-w-96"
          label={spentLabel}
          value={spentUsd}
          cap={capUsd}
          format={formatCost}
        />
      )}
      {invalid && (
        <p className="text-[12px] text-kumo-danger">
          Enter an amount from {formatUsd(min)} to {formatUsd(max)}.
        </p>
      )}
      {mutation.isError && (
        <SectionError message={`The budget was not saved. ${mutation.error.message}`} />
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="secondary"
          loading={mutation.isPending && mutation.variables !== null}
        >
          Save monthly budget
        </Button>
        {capUsd !== null && (
          <Button
            type="button"
            variant="ghost"
            loading={mutation.isPending && mutation.variables === null}
            onClick={() => mutation.mutate(null)}
          >
            Remove the monthly budget
          </Button>
        )}
        <span role="status" className="text-[12px] text-kumo-subtle">
          {mutation.isSuccess && (unchanged || capUsd === null) ? "Saved." : ""}
        </span>
      </div>
    </form>
  );
}
