import { Button, Select } from "@cloudflare/kumo";
import { X } from "@phosphor-icons/react";
import { type ReactNode, useId } from "react";
import { truncate } from "../../lib/format";
import {
  type DagFilter,
  EMPTY_FILTER,
  EVENT_GROUPS,
  type EventGroup,
  filterActive,
  TIME_RANGES,
  type TimeRange,
} from "./model";

/**
 * Filters for the Agents and Events graphs (DESIGN.md 8.2 Select frame, labels above): person
 * (the requester of a Change), Change, Task or agent, event type group, and time range. A field
 * shows only when it has choices, so no control is ever disabled. "All" is the first item of each
 * list; picking it clears that field.
 */

const ALL = "__all";

export type FilterOption = { value: string; label: string };

export function DagFilters({
  filter,
  onChange,
  people,
  changes,
  tasks,
  taskLabel = "Task or agent",
  groups = false,
  showClear = true,
}: {
  filter: DagFilter;
  onChange: (next: DagFilter) => void;
  /** Requesters of the listed Changes. */
  people: FilterOption[];
  changes: FilterOption[];
  tasks: FilterOption[];
  taskLabel?: string;
  /** Show the event type group field. */
  groups?: boolean;
  /** Show "Clear filters"; false when the page shows its own clear control. */
  showClear?: boolean;
}) {
  const id = useId();
  const set = (patch: Partial<DagFilter>) => onChange({ ...filter, ...patch });
  const pick = (value: unknown) => (typeof value === "string" && value !== ALL ? value : null);

  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      {people.length > 0 && (
        <Field id={`${id}-person`} label="Person">
          <Select
            aria-labelledby={`${id}-person`}
            className="w-[200px]"
            value={filter.person ?? ALL}
            onValueChange={(v) => set({ person: pick(v) })}
            items={{ [ALL]: "Everyone", ...options(people, 32) }}
          />
        </Field>
      )}
      {changes.length > 0 && (
        <Field id={`${id}-change`} label="Change">
          <Select
            aria-labelledby={`${id}-change`}
            className="w-[min(320px,calc(100vw-32px))]"
            value={filter.changeId ?? ALL}
            // A Task belongs to one Change: a new Change clears the Task choice.
            onValueChange={(v) => set({ changeId: pick(v), taskId: null })}
            items={{ [ALL]: "All Changes", ...options(changes, 52) }}
          />
        </Field>
      )}
      {tasks.length > 0 && (
        <Field id={`${id}-task`} label={taskLabel}>
          <Select
            aria-labelledby={`${id}-task`}
            className="w-[min(280px,calc(100vw-32px))]"
            value={filter.taskId ?? ALL}
            onValueChange={(v) => set({ taskId: pick(v) })}
            items={{ [ALL]: "All Tasks", ...options(tasks, 44) }}
          />
        </Field>
      )}
      {groups && (
        <Field id={`${id}-group`} label="Event type">
          <Select
            aria-labelledby={`${id}-group`}
            className="w-[170px]"
            value={filter.group ?? ALL}
            onValueChange={(v) => set({ group: pick(v) as EventGroup | null })}
            items={{
              [ALL]: "All types",
              ...Object.fromEntries(Object.entries(EVENT_GROUPS).map(([k, g]) => [k, g.label])),
            }}
          />
        </Field>
      )}
      <Field id={`${id}-range`} label="Time">
        <Select
          aria-labelledby={`${id}-range`}
          className="w-[160px]"
          value={filter.range}
          onValueChange={(v) => {
            if (typeof v === "string" && v in TIME_RANGES) set({ range: v as TimeRange });
          }}
          items={Object.fromEntries(Object.entries(TIME_RANGES).map(([k, r]) => [k, r.label]))}
        />
      </Field>
      {showClear && filterActive(filter) && (
        <Button size="sm" variant="secondary" icon={X} onClick={() => onChange(EMPTY_FILTER)}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
DagFilters.displayName = "DagFilters";

function options(list: FilterOption[], max: number) {
  return Object.fromEntries(list.map((o) => [o.value, truncate(o.label, max)]));
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-[12px] text-kumo-subtle" id={id}>
        {label}
      </span>
      {children}
    </div>
  );
}
