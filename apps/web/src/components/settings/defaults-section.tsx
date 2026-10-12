import { Button, cn, Input } from "@cloudflare/kumo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { type ProjectSettings, updateProjectSettings } from "../../lib/api-settings";
import { formatUsd } from "../../lib/format";
import { can } from "../../lib/permissions";
import { SectionError } from "../project/feedback";
import { KeyValue } from "../ui/key-value";
import { Section } from "../ui/page";
import { ProjectMonthlyBudget } from "./project-monthly-budget";

/**
 * Defaults: the budget of a new Change that is created without one, whether a member's request
 * waits for review, and the Project monthly budget. The owner or an admin sets them; everyone
 * else reads them.
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
      {can(settings.role, "settings.edit") ? (
        <>
          <BudgetForm projectId={projectId} settings={settings} />
          <ReviewToggle projectId={projectId} settings={settings} />
        </>
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
            {
              label: "Member requests need review",
              value: settings.memberRequestReview === false ? "Off" : "On",
            },
          ]}
        />
      )}
      <ProjectMonthlyBudget projectId={projectId} settings={settings} />
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

/**
 * "Member requests need review: On / Off" (segmented control). On: a member's
 * request waits as Proposed until an owner or admin includes it. Owner and admin requests never
 * wait. Saves at once.
 */
function ReviewToggle({ projectId, settings }: { projectId: string; settings: ProjectSettings }) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (memberRequestReview: boolean) =>
      updateProjectSettings({ data: { projectId, memberRequestReview } }),
    onSuccess: (next) => queryClient.setQueryData(["project-settings", projectId], next),
  });
  const on =
    (save.isPending ? save.variables : undefined) ?? settings.memberRequestReview !== false;
  const hintId = useId();
  return (
    <fieldset className="grid gap-1.5 border-t border-kumo-rule pt-3" aria-describedby={hintId}>
      <legend className="float-left mb-1.5 text-[13px] font-semibold">
        Member requests need review
      </legend>
      <div className="clear-left flex w-fit border border-kumo-divider">
        {(
          [
            [true, "On"],
            [false, "Off"],
          ] as const
        ).map(([value, label], index) => (
          <button
            key={label}
            type="button"
            aria-pressed={on === value}
            disabled={save.isPending}
            title={save.isPending ? "Saving" : undefined}
            onClick={() => on !== value && save.mutate(value)}
            className={cn(
              "flex h-8 items-center px-3 text-[13px] transition-colors duration-(--rh-dur-ui) focus-visible:outline-offset-[-2px] pointer-coarse:h-11",
              index > 0 && "border-l border-kumo-divider",
              on === value ? "bg-kumo-ink text-kumo-inverse" : "hover:bg-kumo-tint",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <p id={hintId} className="text-[12px] text-kumo-subtle">
        {on
          ? "A member's request waits as Proposed until an owner or admin includes it."
          : "Member requests start at once. Owner and admin requests never wait."}
      </p>
      {save.isError && (
        <SectionError message={`The setting was not saved. ${save.error.message}`} />
      )}
    </fieldset>
  );
}
ReviewToggle.displayName = "ReviewToggle";
