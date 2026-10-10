import { create } from "zustand";

/**
 * Flight Control client state (AGENTS.md 38, DESIGN.md 10): one selection per page, one hover
 * preview, the time machine, filters and the command palette. Every panel reads and writes this
 * store, so a click in the DAG selects the same entity in the swimlanes, the heatmap, the arena
 * and the inspector (synchronized cross-panel selection).
 *
 * Only client state lives here. Facts come from `flight-model.ts` (derived from API records) and
 * are read through `useFlight()` in flight-context.tsx.
 */

/** What a viewer can select. Ids are the API ids (task id, agent id, candidate id, ...). */
export type EntityKind =
  | "task" // a Task and its agent lane (id = task id)
  | "agent" // a logical agent (id = agent id); resolves to its Task lane when it has one
  | "dependency" // one Work Graph edge (id = `${dependsOnTaskId}->${taskId}`)
  | "candidate" // id = candidate id
  | "conflict" // id = conflict id
  | "changeset" // id = ChangeSet id (`cs_...`)
  | "file" // id = repository path
  | "resource" // id = semantic resource key (`wishlist:membership`)
  | "check" // id = `${candidateId}:${checkId}`
  | "decision" // id = decision id from flight-model (`route:...`, `fork:...`, `gate:...`, ...)
  | "event"; // id = ActivityEvent id

export type EntityRef = { kind: EntityKind; id: string };

const sameRef = (a: EntityRef | null, b: EntityRef | null) =>
  a !== null && b !== null && a.kind === b.kind && a.id === b.id;

/**
 * Time machine. `live` folds every recorded fact and follows new ones as they arrive.
 * `historical` folds only facts recorded at or before `at` (epoch ms); the scrubber moves it.
 * `playing` advances `at` through recorded time at `speed` x real time until the end.
 */
export type FlightTime =
  | { mode: "live" }
  | { mode: "historical"; at: number; playing: boolean; speed: 1 | 4 | 16 };

export const TIER_FILTERS = ["haiku", "sonnet", "opus"] as const;
export type TierFilter = (typeof TIER_FILTERS)[number];

export type FlightFilters = {
  /** Free text: matches Task keys and titles, agent ids, file paths, resources, event types. */
  query: string;
  /** Empty = every tier. */
  tiers: TierFilter[];
  /** Hide lanes that never woke (pending, ready, cancelled). */
  activeOnly: boolean;
  /** Event families to show in event-driven panels. Empty = every family. */
  eventFamilies: string[];
};

export const DEFAULT_FILTERS: FlightFilters = {
  query: "",
  tiers: [],
  activeOnly: false,
  eventFamilies: [],
};

export type PanelId =
  | "dag"
  | "swimlanes"
  | "workspace"
  | "heatmap"
  | "arena"
  | "preview"
  | "evidence"
  | "decisions"
  | "events";

export type FlightStore = {
  selection: EntityRef | null;
  /** Entity under the pointer (hover preview). Never the same as `selection`'s role. */
  hover: EntityRef | null;
  time: FlightTime;
  filters: FlightFilters;
  /** One panel expanded to fill the page; null = the grid. */
  focus: PanelId | null;
  paletteOpen: boolean;
  inspectorOpen: boolean;

  select: (ref: EntityRef | null) => void;
  /** Selects `ref`, or clears the selection when it is already selected. */
  toggle: (ref: EntityRef) => void;
  setHover: (ref: EntityRef | null) => void;
  setTime: (time: FlightTime) => void;
  /** Switches to historical mode at `at` (keeps play state and speed when already historical). */
  scrubTo: (at: number) => void;
  goLive: () => void;
  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: 1 | 4 | 16) => void;
  setFilters: (patch: Partial<FlightFilters>) => void;
  resetFilters: () => void;
  setFocus: (panel: PanelId | null) => void;
  setPaletteOpen: (open: boolean) => void;
  setInspectorOpen: (open: boolean) => void;
  /** Back to the defaults: used when the route's Change changes. */
  reset: () => void;
};

const initial = {
  selection: null,
  hover: null,
  time: { mode: "live" } as FlightTime,
  filters: DEFAULT_FILTERS,
  focus: null,
  paletteOpen: false,
  inspectorOpen: true,
};

export const useFlightStore = create<FlightStore>()((set) => ({
  ...initial,
  select: (ref) => set((s) => ({ selection: ref, inspectorOpen: ref !== null || s.inspectorOpen })),
  toggle: (ref) =>
    set((s) => ({ selection: sameRef(s.selection, ref) ? null : ref, inspectorOpen: true })),
  setHover: (ref) => set((s) => (sameRef(s.hover, ref) ? s : { hover: ref })),
  setTime: (time) => set({ time }),
  scrubTo: (at) =>
    set((s) => ({
      time:
        s.time.mode === "historical"
          ? { ...s.time, at }
          : { mode: "historical", at, playing: false, speed: 1 },
    })),
  goLive: () => set({ time: { mode: "live" } }),
  setPlaying: (playing) =>
    set((s) => (s.time.mode === "historical" ? { time: { ...s.time, playing } } : s)),
  setSpeed: (speed) =>
    set((s) => (s.time.mode === "historical" ? { time: { ...s.time, speed } } : s)),
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  resetFilters: () => set({ filters: DEFAULT_FILTERS }),
  setFocus: (focus) => set({ focus }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  reset: () => set(initial),
}));

/** Selectors shared by panels, so every panel highlights the same way. */
export const useSelection = () => useFlightStore((s) => s.selection);
export const useHover = () => useFlightStore((s) => s.hover);
export const useFlightTime = () => useFlightStore((s) => s.time);
export const useFlightFilters = () => useFlightStore((s) => s.filters);

/** True when `ref` is the selection or the hover target. */
export function useIsHighlighted(ref: EntityRef): { selected: boolean; hovered: boolean } {
  const selected = useFlightStore((s) => sameRef(s.selection, ref));
  const hovered = useFlightStore((s) => sameRef(s.hover, ref));
  return { selected, hovered };
}
