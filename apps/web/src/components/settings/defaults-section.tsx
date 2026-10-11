import { Button, Input } from "@cloudflare/kumo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type ProjectSettings, updateProjectSettings } from "../../lib/api-settings";
import { formatUsd } from "../../lib/format";
import { SectionError } from "../project/feedback";
import { KeyValue } from "../ui/key-value";
import { Section } from "../ui/page";

/**
 * Defaults: the budget of a new Change that is created without one. The owner sets it; a
 * collaborator reads it.
 */
export function DefaultsSection({
  projectId,
  settings,
}: {
  projectId: string;
  settings: ProjectSettings;
}) {
  return (
    <Section label="Defaults">
      {settings.role === "owner" ? (
        <BudgetForm projectId={projectId} settings={settings} />
      ) : (
        <KeyValue
          items={[
            {
              label: "Change budget",
              value: (
                <span className="font-mono tabular-nums">
                  {formatUsd(settings.effectiveDefaultBudgetUsd)}
                </span>
              ),
            },
          ]}
        />
      )}
    </Section>
  );
}
DefaultsSection.displayName = "DefaultsSection";

function BudgetForm({ projectId, settings }: { projectId: string; settings: ProjectSettings }) {
  const queryClient = useQueryClient();
  const { minBudgetUsd: min, maxBudgetUsd: max } = settings.limits;
  const stored = String(settings.effectiveDefaultBudgetUsd);
  const [value, setValue] = useState(stored);
  useEffect(() => setValue(stored), [stored]);
  const amount = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(amount) && amount >= min && amount <= max;

  const save = useMutation({
    mutationFn: (defaultBudgetUsd: number | null) =>
      updateProjectSettings({ data: { projectId, defaultBudgetUsd } }),
    onSuccess: (next) => queryClient.setQueryData(["project-settings", projectId], next),
  });
  const [invalid, setInvalid] = useState(false);
  const unchanged = valid && amount === settings.effectiveDefaultBudgetUsd;

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
        if (!unchanged) save.mutate(Math.round(amount * 100) / 100);
      }}
    >
      <div className="max-w-56">
        <Input
          label="Change budget (USD)"
          description={`Used when a Change is created without a budget. ${formatUsd(min)} to ${formatUsd(max)}.`}
          type="number"
          min={min}
          max={max}
          step={0.1}
          className="font-mono"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
            save.reset();
          }}
          aria-invalid={invalid || undefined}
          required
        />
      </div>
      {invalid && (
        <p className="text-[12px] text-kumo-danger">
          Enter an amount from {formatUsd(min)} to {formatUsd(max)}.
        </p>
      )}
      {save.isError && <SectionError message={`The budget was not saved. ${save.error.message}`} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="secondary"
          loading={save.isPending && save.variables !== null}
        >
          Save budget
        </Button>
        {settings.defaultBudgetUsd !== null && (
          <Button
            type="button"
            variant="ghost"
            loading={save.isPending && save.variables === null}
            onClick={() => save.mutate(null)}
          >
            Use the built-in default
          </Button>
        )}
        <span role="status" className="text-[12px] text-kumo-subtle">
          {save.isSuccess && unchanged
            ? "Saved."
            : settings.defaultBudgetUsd === null && unchanged
              ? "Built-in default."
              : ""}
        </span>
      </div>
    </form>
  );
}
