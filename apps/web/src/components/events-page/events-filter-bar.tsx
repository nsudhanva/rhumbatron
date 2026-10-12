import { Button, Input } from "@cloudflare/kumo";
import { X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { formatNumber } from "../../lib/format";
import { DagFilters, type FilterOption } from "../dag/dag-filters";
import { activeFilterCount, type EventsFilter } from "../dag/filter-search";
import type { EventGroup } from "../dag/model";
import { EventGroupChips } from "./event-filters";

/** Typing waits this long before the URL (and the list) follow the search text. */
const TYPING_MS = 250;

/**
 * Filter bar of the Events page, shared by the List and Graph views: search text
 * over event type, summary and ids; person; Change by short title; Task or agent; time range; and
 * the event type group as chips. The filter lives in the URL. The bar shows how many fields are
 * set and clears them all at once.
 */
export function EventsFilterBar({
  filter,
  onChange,
  people,
  changes,
  tasks,
  groupCounts,
  groupTotal,
}: {
  filter: EventsFilter;
  onChange: (next: EventsFilter) => void;
  people: FilterOption[];
  changes: FilterOption[];
  tasks: FilterOption[];
  groupCounts: ReadonlyMap<EventGroup | "other", number>;
  groupTotal: number;
}) {
  const [text, setText] = useState(filter.query);
  const latest = useRef({ filter, onChange });
  latest.current = { filter, onChange };
  // A Clear or a back navigation changes the query from outside: show it.
  useEffect(() => setText(filter.query), [filter.query]);
  useEffect(() => {
    if (text === latest.current.filter.query) return;
    const timer = setTimeout(() => {
      const { filter: current, onChange: commit } = latest.current;
      commit({ ...current, query: text });
    }, TYPING_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const active = activeFilterCount({ ...filter, query: text });
  const clear = () => {
    setText("");
    onChange({
      query: "",
      person: null,
      changeId: null,
      taskId: null,
      group: null,
      range: "all",
    });
  };

  return (
    <search aria-label="Event filters" className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="grid gap-1.5">
          <label htmlFor="events-search" className="text-[12px] text-kumo-subtle">
            Search
          </label>
          <Input
            id="events-search"
            type="search"
            className="w-[min(280px,calc(100vw-32px))]"
            placeholder="Type, summary or id"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <DagFilters
          filter={filter}
          onChange={(next) => onChange({ ...next, query: text })}
          people={people}
          changes={changes}
          tasks={tasks}
          showClear={false}
        />
        {active > 0 && (
          <div className="flex items-center gap-3">
            <span className="font-mono text-[12px] text-kumo-subtle tabular-nums" role="status">
              {formatNumber(active)} {active === 1 ? "filter" : "filters"}
            </span>
            <Button size="sm" variant="secondary" icon={X} onClick={clear}>
              Clear
            </Button>
          </div>
        )}
      </div>
      <EventGroupChips
        counts={groupCounts}
        total={groupTotal}
        selected={filter.group}
        onChange={(group) => onChange({ ...filter, query: text, group })}
      />
    </search>
  );
}
EventsFilterBar.displayName = "EventsFilterBar";
