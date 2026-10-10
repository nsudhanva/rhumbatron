import { Button, cn } from "@cloudflare/kumo";
import { X } from "@phosphor-icons/react";
import { type ComponentType, lazy, Suspense, useId, useMemo } from "react";
import { truncate } from "../../lib/format";
import { useFlight } from "./flight-context";
import { entityLabel, type FlightState, relatedRefs } from "./flight-model";
import { type EntityKind, type EntityRef, useFlightStore, useSelection } from "./flight-store";

/**
 * Inspector for the one selected entity (DESIGN.md 10: one selection per context; the inspector
 * and the selected item share the accent bar). A right-hand column on wide screens, below the
 * panels on narrow ones. The related chips walk the causal neighbourhood of the selection.
 * Inspector modules load on first selection, so they cost nothing on first paint.
 */

type InspectorProps = { entity: EntityRef };
const named = <K extends string>(
  load: () => Promise<Record<K, ComponentType<InspectorProps>>>,
  name: K,
) => lazy(() => load().then((m) => ({ default: m[name] })));

const taskModule = () => import("./inspectors/task-inspector");
const fileModule = () => import("./inspectors/file-inspector");
const candidateModule = () => import("./inspectors/candidate-inspector");
const decisionModule = () => import("./inspectors/decision-inspector");

const INSPECTORS: Record<EntityKind, ComponentType<InspectorProps>> = {
  task: named(taskModule, "TaskInspector"),
  agent: named(taskModule, "AgentInspector"),
  dependency: named(() => import("./inspectors/dependency-inspector"), "DependencyInspector"),
  file: named(fileModule, "FileInspector"),
  resource: named(fileModule, "ResourceInspector"),
  check: named(fileModule, "CheckInspector"),
  candidate: named(candidateModule, "CandidateInspector"),
  conflict: named(candidateModule, "ConflictInspector"),
  changeset: named(candidateModule, "ChangeSetInspector"),
  decision: named(decisionModule, "DecisionInspector"),
  event: named(decisionModule, "EventInspector"),
};

/** Related chips, grouped in this order; at most MAX_CHIPS in total. */
const GROUPS: { kind: EntityKind; label: string }[] = [
  { kind: "task", label: "Tasks" },
  { kind: "file", label: "Files" },
  { kind: "candidate", label: "Candidates" },
  { kind: "conflict", label: "Conflicts" },
  { kind: "decision", label: "Decisions" },
];
const MAX_CHIPS = 12;

function chipLabel(state: FlightState, ref: EntityRef): string {
  switch (ref.kind) {
    case "task":
      return state.tasks[ref.id]?.key ?? ref.id;
    case "file":
      return ref.id.split("/").at(-1) ?? ref.id;
    case "candidate":
      return state.candidates[ref.id]?.name ?? ref.id;
    default:
      return truncate(entityLabel(state, ref).title, 32);
  }
}

function Related({ state, selection }: { state: FlightState; selection: EntityRef }) {
  const select = useFlightStore((s) => s.select);
  const groups = useMemo(() => {
    const keys = relatedRefs(state, selection);
    const self = `${selection.kind}:${selection.id}`;
    return GROUPS.map((g) => ({
      ...g,
      refs: [...keys]
        .filter((k) => k !== self && k.startsWith(`${g.kind}:`))
        .map((k) => ({ kind: g.kind, id: k.slice(g.kind.length + 1) })),
    })).filter((g) => g.refs.length > 0);
  }, [state, selection]);

  if (groups.length === 0) return null;
  let budget = MAX_CHIPS;
  const total = groups.reduce((n, g) => n + g.refs.length, 0);
  return (
    <nav aria-label="Related" className="grid gap-1.5 border-b border-kumo-rule px-3 py-2">
      {groups.map((g) => {
        const shown = g.refs.slice(0, Math.max(0, budget));
        budget -= shown.length;
        if (shown.length === 0) return null;
        return (
          <div key={g.kind} className="flex flex-wrap items-center gap-1">
            <span className="w-[88px] shrink-0 text-[12px] text-kumo-subtle">{g.label}</span>
            {shown.map((ref) => {
              const full = entityLabel(state, ref);
              return (
                <button
                  key={ref.id}
                  type="button"
                  title={`${full.kicker}: ${full.title}`}
                  onClick={() => select(ref)}
                  className={cn(
                    "min-h-6 max-w-[180px] truncate border border-kumo-rule px-2 py-0.5 text-[12px] hover:bg-kumo-tint pointer-coarse:min-h-11",
                    (ref.kind === "task" || ref.kind === "file") && "font-mono text-[12px]",
                  )}
                >
                  {chipLabel(state, ref)}
                </button>
              );
            })}
          </div>
        );
      })}
      {total > MAX_CHIPS && (
        <p className="text-[12px] text-kumo-subtle">+{total - MAX_CHIPS} more</p>
      )}
    </nav>
  );
}
Related.displayName = "Related";

export function InspectorDrawer({ className }: { className?: string }) {
  const { state } = useFlight();
  const selection = useSelection();
  const select = useFlightStore((s) => s.select);
  const setInspectorOpen = useFlightStore((s) => s.setInspectorOpen);
  const headingId = useId();
  if (!selection) return null;
  const label = entityLabel(state, selection);
  const Inspector = INSPECTORS[selection.kind];
  const close = () => {
    select(null);
    setInspectorOpen(false);
  };
  return (
    <aside
      aria-labelledby={headingId}
      className={cn(
        "flex min-w-0 flex-col bg-kumo-elevated shadow-[inset_2px_0_0_var(--color-accent-500)]",
        className,
      )}
    >
      <header className="flex items-start justify-between gap-3 border-b border-kumo-rule py-2 pr-1.5 pl-4">
        <div className="grid min-w-0 gap-1">
          <p className="text-[12px] text-kumo-accent">{label.kicker}</p>
          <h2 id={headingId} className="type-h5 break-words">
            {label.title}
          </h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={<X size={16} aria-hidden />}
          aria-label="Close inspector"
          title="Close inspector (Esc)"
          onClick={close}
        />
      </header>
      <Related state={state} selection={selection} />
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        <Suspense
          fallback={
            <div aria-hidden className="grid gap-2">
              <span className="h-[13px] w-2/3 animate-pulse bg-kumo-faint motion-reduce:animate-none" />
              <span className="h-[13px] w-1/2 animate-pulse bg-kumo-faint motion-reduce:animate-none" />
            </div>
          }
        >
          <Inspector key={`${selection.kind}:${selection.id}`} entity={selection} />
        </Suspense>
      </div>
    </aside>
  );
}
InspectorDrawer.displayName = "InspectorDrawer";
