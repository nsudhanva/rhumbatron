import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import type { TimelineModel } from "./timeline-model";

/**
 * Which people and Changes of the execution timeline are collapsed, kept per Project in this
 * browser so a return to the Overview shows the timeline as the viewer left it.
 *
 * Defaults (no stored choice): every person is open; a Change in flight is open and a finished
 * Change is collapsed. Storage keeps only the viewer's own choices, so a new Change gets its
 * default and a Change that finishes collapses unless the viewer opened it on purpose.
 *
 * Storage is best effort (localStorage in try/catch). The server and the first client render use
 * the defaults; the stored choices apply in a layout effect after hydration, before paint.
 */

type Choices = { people: Record<string, boolean>; changes: Record<string, boolean> };
type Kind = keyof Choices;

const EMPTY: Choices = { people: {}, changes: {} };
const storageKey = (projectId: string) => `rhumbatron:timeline:${projectId}`;

const flags = (value: unknown): Record<string, boolean> => {
  const out: Record<string, boolean> = {};
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) if (typeof v === "boolean") out[k] = v;
  }
  return out;
};

function read(projectId: string): Choices {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Choices>;
    return { people: flags(parsed.people), changes: flags(parsed.changes) };
  } catch {
    // Storage blocked or corrupt: the defaults apply.
    return EMPTY;
  }
}

function write(projectId: string, choices: Choices) {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(choices));
  } catch {
    // Storage blocked: the choice still applies for this page view.
  }
}

/** Keeps only choices for rows the model still has, so storage does not grow without bound. */
function prune(choices: Choices, model: TimelineModel): Choices {
  const people = new Set(model.people.map((p) => p.key));
  const changes = new Set(model.people.flatMap((p) => p.changes.map((c) => c.id)));
  const keep = (rec: Record<string, boolean>, ids: Set<string>) =>
    Object.fromEntries(Object.entries(rec).filter(([k]) => ids.has(k)));
  return { people: keep(choices.people, people), changes: keep(choices.changes, changes) };
}

export function useTimelineDisclosure(projectId: string, model: TimelineModel) {
  const [choices, setChoices] = useState<Choices>(EMPTY);
  useLayoutEffect(() => setChoices(read(projectId)), [projectId]);

  const collapsed = useMemo(() => {
    const people = new Set<string>();
    const changes = new Set<string>();
    for (const person of model.people) {
      if (choices.people[person.key] ?? false) people.add(person.key);
      for (const change of person.changes) {
        if (choices.changes[change.id] ?? change.end !== null) changes.add(change.id);
      }
    }
    return { people, changes } as const;
  }, [model, choices]);

  const toggle = useCallback(
    (kind: Kind, id: string) => {
      const next: Choices = {
        ...choices,
        [kind]: { ...choices[kind], [id]: !collapsed[kind].has(id) },
      };
      const kept = prune(next, model);
      write(projectId, kept);
      setChoices(kept);
    },
    [choices, collapsed, model, projectId],
  );

  return { collapsed, toggle };
}
