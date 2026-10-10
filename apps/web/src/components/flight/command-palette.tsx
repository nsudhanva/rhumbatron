import { CommandPalette as Palette } from "@cloudflare/kumo";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { generation } from "../../lib/format";
import { statusView } from "../ui/status-pill";
import { useFlight } from "./flight-context";
import type { FlightModel, FlightState } from "./flight-model";
import {
  DEFAULT_FILTERS,
  type EntityRef,
  type FlightFilters,
  type FlightTime,
  type PanelId,
  TIER_FILTERS,
  useFlightFilters,
  useFlightStore,
  useFlightTime,
} from "./flight-store";
import { stepFact } from "./scrubber";

/**
 * Command palette (DESIGN.md 8.6), opened with Cmd/Ctrl+K (the page registers the shortcut).
 * Built on Kumo's CommandPalette (Base UI Dialog + Autocomplete): focus trap and return, Escape,
 * arrow keys and Enter come from Kumo. Commands act on the current Debug view state only:
 * jump to any entity, focus a panel, move the time machine, toggle filters, open related pages.
 */

type Command = {
  id: string;
  title: string;
  /** Right-aligned context: a status word, an id, "on" / "off". */
  detail?: string | undefined;
  /** Keyboard shortcut that does the same outside the palette. */
  shortcut?: string;
  /** Extra words the query matches (ids, paths). */
  keywords?: string;
  run: () => void;
};

type Group = { id: string; label: string; items: Command[] };

const JUMP_CAP = 8;

const PANELS: { id: PanelId; label: string }[] = [
  { id: "dag", label: "Execution DAG" },
  { id: "swimlanes", label: "Agent swimlanes" },
  { id: "workspace", label: "Workspace lanes" },
  { id: "heatmap", label: "Codebase heatmap" },
  { id: "arena", label: "Candidate arena" },
  { id: "preview", label: "Preview wall" },
  { id: "evidence", label: "Evidence explorer" },
  { id: "decisions", label: "Decisions" },
  { id: "events", label: "Events" },
];

/** Every query word appears somewhere in the command's text ("fuzzy-ish" substring match). */
function matcher(query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return (c: Command) => {
    if (words.length === 0) return true;
    const hay = `${c.title} ${c.detail ?? ""} ${c.keywords ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
}

const store = () => useFlightStore.getState();
const pick = (ref: EntityRef) => () => store().select(ref);

function jumpGroups(state: FlightState): Group[] {
  const tasks = state.taskOrder.map((id) => state.tasks[id]).filter((t) => t !== undefined);
  return [
    {
      id: "tasks",
      label: "Jump to · Tasks",
      items: tasks.map((t) => ({
        id: `task:${t.id}`,
        title: `${t.key} · ${t.title}`,
        detail: statusView(t.status).label,
        keywords: t.id,
        run: pick({ kind: "task", id: t.id }),
      })),
    },
    {
      id: "agents",
      label: "Jump to · Agents",
      items: tasks
        .filter((t) => t.agentId)
        .map((t) => ({
          id: `agent:${t.agentId}`,
          title: `${t.key} agent`,
          detail: t.agentId ?? undefined,
          run: pick({ kind: "agent", id: t.agentId as string }),
        })),
    },
    {
      id: "candidates",
      label: "Jump to · Candidates",
      items: state.candidateOrder
        .map((id) => state.candidates[id])
        .filter((c) => c !== undefined)
        .map((c) => ({
          id: `candidate:${c.id}`,
          title: c.name,
          detail: statusView(c.status).label,
          keywords: c.id,
          run: pick({ kind: "candidate", id: c.id }),
        })),
    },
    {
      id: "conflicts",
      label: "Jump to · Conflicts",
      items: state.conflicts.map((c) => ({
        id: `conflict:${c.id}`,
        title: `Conflict on ${c.resource}`,
        detail: statusView(c.state).label,
        keywords: `${c.id} ${c.statements.join(" ")}`,
        run: pick({ kind: "conflict", id: c.id }),
      })),
    },
    {
      id: "files",
      label: "Jump to · Files",
      items: state.files.map((f) => ({
        id: `file:${f.path}`,
        title: f.path,
        detail: f.contended ? "contended" : undefined,
        run: pick({ kind: "file", id: f.path }),
      })),
    },
    {
      id: "resources",
      label: "Jump to · Resources",
      items: state.resources.map((r) => ({
        id: `resource:${r.resource}`,
        title: r.resource,
        detail: r.protectedResource ? "protected" : undefined,
        run: pick({ kind: "resource", id: r.resource }),
      })),
    },
    {
      id: "checks",
      label: "Jump to · Checks",
      items: state.candidateOrder.flatMap((candidateId) => {
        const c = state.candidates[candidateId];
        if (!c) return [];
        return c.checks.map((check) => ({
          id: `check:${c.id}:${check.checkId}`,
          title: `${check.checkId} · ${c.name}`,
          detail: check.coverage === "not_checked" ? "Gap" : statusView(check.status).label,
          run: pick({ kind: "check", id: `${c.id}:${check.checkId}` }),
        }));
      }),
    },
    {
      id: "decisions",
      label: "Jump to · Decisions",
      items: [...state.decisions].reverse().map((d) => ({
        id: `decision:${d.id}`,
        title: d.title,
        detail: d.kind,
        keywords: `${d.by} ${d.verdict}`,
        run: pick({ kind: "decision", id: d.id }),
      })),
    },
  ];
}

function commandGroups(
  model: FlightModel,
  time: FlightTime,
  focus: PanelId | null,
  filters: FlightFilters,
  go: (to: Nav) => void,
): Group[] {
  const s = store;
  const events = model.events;
  const first = events[0];
  const last = events.at(-1);
  const historical = time.mode === "historical";
  const previous = stepFact(events, time, -1);
  const next = stepFact(events, time, 1);

  const timeItems: Command[] = [];
  if (historical) timeItems.push({ id: "time:live", title: "Go live", run: () => s().goLive() });
  if (historical && time.playing) {
    timeItems.push({ id: "time:pause", title: "Pause", run: () => s().setPlaying(false) });
  } else if (historical) {
    timeItems.push({ id: "time:play", title: "Play", run: () => s().setPlaying(true) });
  } else if (first) {
    timeItems.push({
      id: "time:replay",
      title: "Replay from the first fact",
      run: () => {
        s().scrubTo(first.at);
        s().setPlaying(true);
      },
    });
  }
  if (historical) {
    for (const speed of [1, 4, 16] as const) {
      timeItems.push({
        id: `time:speed:${speed}`,
        title: `Speed ${speed}x`,
        detail: time.speed === speed ? "current" : undefined,
        run: () => s().setSpeed(speed),
      });
    }
  }
  if (previous !== null && previous !== "live") {
    timeItems.push({
      id: "time:previous",
      title: "Step to the previous fact",
      shortcut: "[",
      run: () => s().scrubTo(previous),
    });
  }
  if (next !== null) {
    timeItems.push({
      id: "time:next",
      title: next === "live" ? "Step forward to live" : "Step to the next fact",
      shortcut: "]",
      run: () => (next === "live" ? s().goLive() : s().scrubTo(next)),
    });
  }
  if (first) {
    timeItems.push({
      id: "time:first",
      title: "Jump to the first fact",
      detail: first.type,
      run: () => s().scrubTo(first.at),
    });
  }
  if (last) {
    timeItems.push({
      id: "time:last",
      title: "Jump to the last fact",
      detail: last.type,
      run: () => s().scrubTo(last.at),
    });
  }
  for (const e of events) {
    if (e.kind === "candidate.fork") {
      const name = model.activity.candidates.find((c) => c.id === e.candidateId)?.name;
      timeItems.push({
        id: `time:fork:${e.id}`,
        title: `Jump to the fork of ${name ?? e.candidateId}`,
        run: () => s().scrubTo(e.at),
      });
    } else if (e.kind === "promoted") {
      timeItems.push({
        id: `time:promoted:${e.id}`,
        title: `Jump to the promotion to ${generation(e.generation)}`,
        run: () => s().scrubTo(e.at),
      });
    }
  }

  const tierItems: Command[] = TIER_FILTERS.map((tier) => {
    const on = filters.tiers.includes(tier);
    return {
      id: `filter:tier:${tier}`,
      title: `Filter tier ${tier}`,
      detail: on ? "on" : "off",
      run: () =>
        s().setFilters({
          tiers: on ? filters.tiers.filter((t) => t !== tier) : [...filters.tiers, tier],
        }),
    };
  });
  const isDefault =
    filters.query === DEFAULT_FILTERS.query &&
    filters.tiers.length === 0 &&
    !filters.activeOnly &&
    filters.eventFamilies.length === 0;

  return [
    {
      id: "panels",
      label: "Panels",
      items: [
        ...PANELS.map((p) => ({
          id: `panel:${p.id}`,
          title: `Focus ${p.label}`,
          detail: focus === p.id ? "shown" : undefined,
          run: () => s().setFocus(p.id),
        })),
        ...(focus
          ? [
              {
                id: "panel:all",
                title: "Show all panels",
                shortcut: "Esc",
                run: () => s().setFocus(null),
              },
            ]
          : []),
      ],
    },
    { id: "time", label: "Time", items: timeItems },
    {
      id: "filters",
      label: "Filters",
      items: [
        ...tierItems,
        {
          id: "filter:active",
          title: "Active lanes only",
          detail: filters.activeOnly ? "on" : "off",
          run: () => s().setFilters({ activeOnly: !filters.activeOnly }),
        },
        ...(isDefault
          ? []
          : [{ id: "filter:reset", title: "Reset filters", run: () => s().resetFilters() }]),
      ],
    },
    {
      id: "navigate",
      label: "Navigate",
      items: [
        {
          id: "nav:change",
          title: "Open the Change page",
          run: () => go({ to: "/changes/$changeId" }),
        },
        {
          id: "nav:compare",
          title: "Compare Candidates",
          run: () => go({ to: "/compare/$changeId" }),
        },
        {
          id: "nav:project",
          title: "Open the Project overview",
          run: () => go({ to: "/projects/$projectId" }),
        },
        {
          id: "nav:agents",
          title: "Open Agents",
          run: () => go({ to: "/projects/$projectId/agents" }),
        },
        {
          id: "nav:events",
          title: "Open Events",
          run: () => go({ to: "/projects/$projectId/events" }),
        },
        {
          id: "nav:workspace",
          title: "Open Workspace",
          run: () => go({ to: "/projects/$projectId/workspace" }),
        },
        {
          id: "nav:verification",
          title: "Open Verification",
          run: () => go({ to: "/projects/$projectId/verification" }),
        },
        {
          id: "nav:costs",
          title: "Open Costs",
          run: () => go({ to: "/projects/$projectId/costs" }),
        },
      ],
    },
  ];
}

type Nav =
  | { to: "/changes/$changeId" | "/compare/$changeId" }
  | {
      to:
        | "/projects/$projectId"
        | "/projects/$projectId/agents"
        | "/projects/$projectId/events"
        | "/projects/$projectId/workspace"
        | "/projects/$projectId/verification"
        | "/projects/$projectId/costs";
    };

/**
 * The overlay renders into its own stacking layer on <body>, above the sticky Flight chrome and
 * positioned panel content (Kumo's palette sets no z-index of its own). Created once, attached
 * before the dialog mounts so Base UI can move focus into it on the first open.
 */
let layer: HTMLDivElement | null = null;
function paletteLayer(): HTMLDivElement | null {
  if (typeof document === "undefined") return null;
  if (!layer?.isConnected) {
    layer = document.createElement("div");
    layer.className = "relative z-50";
    document.body.appendChild(layer);
  }
  return layer;
}

export function CommandPalette() {
  const open = useFlightStore((s) => s.paletteOpen);
  const setOpen = useFlightStore((s) => s.setPaletteOpen);
  const focus = useFlightStore((s) => s.focus);
  const time = useFlightTime();
  const filters = useFlightFilters();
  const { state, model, projectId, changeId } = useFlight();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  // Focus goes back to what had it before the palette opened (the page opens it from a
  // shortcut, so there is no trigger for the dialog to return to).
  const wasOpen = useRef(false);
  const returnTo = useRef<Element | null>(null);
  if (open && !wasOpen.current && typeof document !== "undefined") {
    returnTo.current = document.activeElement;
  }
  wasOpen.current = open;
  useEffect(() => {
    if (open) return;
    const el = returnTo.current;
    returnTo.current = null;
    if (!(el instanceof HTMLElement) || !el.isConnected) return;
    // Wait for the dialog's exit transition to release focus, then restore it.
    let frame = 0;
    let tries = 0;
    const settle = () => {
      const current = document.activeElement;
      if (current && layer?.contains(current) && tries++ < 60) {
        frame = requestAnimationFrame(settle);
        return;
      }
      if (!current || current === document.body) el.focus({ preventScroll: true });
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const groups = useMemo(() => {
    if (!open) return [];
    const go = (nav: Nav) => {
      if (nav.to === "/changes/$changeId" || nav.to === "/compare/$changeId") {
        void navigate({ to: nav.to, params: { changeId } });
      } else {
        void navigate({ to: nav.to, params: { projectId } });
      }
    };
    const match = matcher(query);
    const jump = jumpGroups(state)
      .map((g) => ({ ...g, items: g.items.filter(match).slice(0, JUMP_CAP) }))
      .filter((g) => g.items.length > 0);
    const commands = commandGroups(model, time, focus, filters, go)
      .map((g) => ({ ...g, items: g.items.filter(match) }))
      .filter((g) => g.items.length > 0);
    // With a query, entities lead (the reader is looking for something); without one, actions.
    return query.trim() ? [...jump, ...commands] : [...commands, ...jump];
  }, [open, query, state, model, time, focus, filters, navigate, projectId, changeId]);

  const run = (command: Command) => {
    command.run();
    setOpen(false);
    setQuery("");
  };

  return (
    <Palette.Root
      container={paletteLayer()}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      items={groups}
      value={query}
      onValueChange={setQuery}
      itemToStringValue={(group: Group) => group.label}
      getSelectableItems={(gs: Group[]) => gs.flatMap((g) => g.items)}
      onSelect={(command: Command) => run(command)}
    >
      <Palette.Input
        placeholder="Jump to a Task, file, Candidate, decision, or run a command"
        aria-label="Search entities and commands"
      />
      <Palette.List>
        <Palette.Results>
          {(group: Group) => (
            <Palette.Group key={group.id} items={group.items}>
              <Palette.GroupLabel className="mb-1 pt-2 text-[12px] font-normal">
                {group.label}
              </Palette.GroupLabel>
              <Palette.Items>
                {(command: Command) => (
                  <Palette.Item
                    key={command.id}
                    value={command}
                    onClick={() => run(command)}
                    className="min-h-8 rounded-none py-1 text-[13px] data-[highlighted]:bg-kumo-faint data-[highlighted]:shadow-[inset_2px_0_0_var(--color-accent-500)]"
                  >
                    <span className="min-w-0 flex-1 truncate">{command.title}</span>
                    {command.detail && (
                      <span className="max-w-[40%] shrink-0 truncate font-mono text-[12px] text-kumo-subtle">
                        {command.detail}
                      </span>
                    )}
                    {command.shortcut && (
                      <kbd className="shrink-0 border border-kumo-rule px-1 py-px font-mono text-[12px] text-kumo-subtle">
                        {command.shortcut}
                      </kbd>
                    )}
                  </Palette.Item>
                )}
              </Palette.Items>
            </Palette.Group>
          )}
        </Palette.Results>
        <Palette.Empty>Nothing in this Change matches.</Palette.Empty>
      </Palette.List>
      <Palette.Footer>
        <span className="flex items-center gap-3 font-mono text-[12px]">
          <span>↑↓ move</span>
          <span>↵ run</span>
          <span>Esc close</span>
        </span>
        <span className="font-mono text-[12px]">⌘K / Ctrl K</span>
      </Palette.Footer>
    </Palette.Root>
  );
}
CommandPalette.displayName = "CommandPalette";
