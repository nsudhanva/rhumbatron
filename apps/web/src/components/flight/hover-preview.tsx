import {
  cloneElement,
  type FocusEvent,
  isValidElement,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { formatClock, formatNumber, truncate } from "../../lib/format";
import { StatusPill } from "../ui/status-pill";
import { useFlight } from "./flight-context";
import {
  entityLabel,
  type FlightModel,
  type FlightState,
  providerName,
  type TaskState,
  taskOfAgent,
} from "./flight-model";
import { type EntityRef, useFlightStore } from "./flight-store";

/**
 * Contextual hover preview (DESIGN.md 8.4 tooltip timing, 10 hover). Wraps any element that
 * stands for an entity. After a 400ms hover, or at once on keyboard focus, a small non-modal
 * card shows that entity's state at the fold instant and `hover` is set in the store so every
 * panel highlights the same entity. The card is a summary of facts every panel and inspector
 * also show; it holds nothing that is available nowhere else.
 *
 * Cheap by construction: panels wrap hundreds of elements, so the wrapper adds no DOM node (the
 * handlers are merged into its one child), keeps one boolean of state, and shares ONE module
 * timer. Only one preview exists at a time; it never takes focus, Escape or a scroll closes it,
 * and the pointer can rest on the card (WCAG 1.4.13).
 */

const SHOW_DELAY_MS = 400;
/** Grace period to move the pointer from the element onto the card. */
const HIDE_DELAY_MS = 120;
/** Moving from one preview to the next within this window shows the next at once. */
const SKIP_DELAY_MS = 300;

type Owner = { close: () => void };
let active: Owner | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
/** Whose show timer is pending, so an unmounting owner can cancel only its own. */
let pending: Owner | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let lastClosedAt = 0;

const clearShow = () => {
  if (showTimer) clearTimeout(showTimer);
  showTimer = null;
  pending = null;
};
const clearHide = () => {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
};

type ChildProps = {
  onPointerEnter?: (e: PointerEvent<Element>) => void;
  onPointerLeave?: (e: PointerEvent<Element>) => void;
  onPointerDown?: (e: PointerEvent<Element>) => void;
  onFocus?: (e: FocusEvent<Element>) => void;
  onBlur?: (e: FocusEvent<Element>) => void;
  "aria-describedby"?: string | undefined;
  id?: string;
};

/**
 * `show` makes the preview controlled, for items of a one-tab-stop composite (use-roving-focus):
 * the composite owns pointer and focus and says which item is pointer-near (`pointer`: the usual
 * 400ms delay) or keyboard-active (`focus`: at once). The child needs an `id` to anchor the card.
 */
export function EntityHover({
  entity,
  show,
  children,
}: {
  entity: EntityRef;
  show?: "focus" | "pointer" | null;
  children: ReactNode;
}) {
  const [anchor, setAnchor] = useState<Element | null>(null);
  const tooltipId = useId();
  const entityRef = useRef(entity);
  entityRef.current = entity;
  const owner = useRef<Owner | null>(null);
  if (!owner.current) owner.current = { close: () => setAnchor(null) };

  const open = useCallback((el: Element) => {
    clearShow();
    clearHide();
    const self = owner.current as Owner;
    if (active && active !== self) active.close();
    active = self;
    setAnchor(el);
    useFlightStore.getState().setHover(entityRef.current);
  }, []);

  const close = useCallback(() => {
    clearShow();
    clearHide();
    if (active !== owner.current) return;
    active = null;
    lastClosedAt = performance.now();
    setAnchor(null);
    useFlightStore.getState().setHover(null);
  }, []);

  const scheduleClose = useCallback(() => {
    clearHide();
    hideTimer = setTimeout(close, HIDE_DELAY_MS);
  }, [close]);

  // Unmounting while open (a panel re-keyed, the time machine moved) drops the preview.
  useEffect(
    () => () => {
      if (pending === owner.current) clearShow();
      if (active === owner.current) {
        clearShow();
        clearHide();
        active = null;
        useFlightStore.getState().setHover(null);
      }
    },
    [],
  );

  // Controlled mode: follow the composite's pointer-near or keyboard-active item.
  const controlled = show !== undefined;
  const childId =
    isValidElement<ChildProps>(children) && typeof children.props.id === "string"
      ? children.props.id
      : null;
  const shown = useRef<"focus" | "pointer" | null>(null);
  useEffect(() => {
    if (!controlled) return;
    const prev = shown.current;
    shown.current = show ?? null;
    if (show === prev) return;
    const el = childId ? document.getElementById(childId) : null;
    if (show && el) {
      if (show === "focus" || active === owner.current) {
        open(el);
        return;
      }
      clearShow();
      const warm = active !== null || performance.now() - lastClosedAt < SKIP_DELAY_MS;
      if (warm) open(el);
      else {
        pending = owner.current;
        showTimer = setTimeout(() => open(el), SHOW_DELAY_MS);
      }
      return;
    }
    if (pending === owner.current) clearShow();
    if (active === owner.current) {
      if (prev === "pointer") scheduleClose();
      else close();
    }
  }, [controlled, show, childId, open, close, scheduleClose]);

  const handlers = {
    onPointerEnter: (e: PointerEvent<Element>) => {
      if (e.pointerType === "touch") return;
      const el = target(e.currentTarget);
      if (active === owner.current) {
        clearHide();
        return;
      }
      clearShow();
      const warm = active !== null || performance.now() - lastClosedAt < SKIP_DELAY_MS;
      if (warm) open(el);
      else {
        pending = owner.current;
        showTimer = setTimeout(() => open(el), SHOW_DELAY_MS);
      }
    },
    onPointerLeave: () => {
      clearShow();
      if (active === owner.current) scheduleClose();
    },
    onPointerDown: () => {
      clearShow();
      if (active === owner.current) close();
    },
    onFocus: (e: FocusEvent<Element>) => {
      const el = target(e.currentTarget);
      // Keyboard focus only: a click also focuses, and should not pop a card.
      if (e.target instanceof Element && e.target.matches(":focus-visible")) open(el);
    },
    onBlur: () => {
      if (active === owner.current) close();
    },
  };

  const card = anchor
    ? createPortal(
        <HoverCard
          id={tooltipId}
          entity={entity}
          anchor={anchor}
          onClose={close}
          onPointerEnter={clearHide}
          onPointerLeave={scheduleClose}
        />,
        document.body,
      )
    : null;

  if (controlled && isValidElement<ChildProps>(children)) {
    const props = children.props;
    return (
      <>
        {cloneElement(children as ReactElement<ChildProps>, {
          "aria-describedby": anchor
            ? [props["aria-describedby"], tooltipId].filter(Boolean).join(" ")
            : props["aria-describedby"],
        })}
        {card}
      </>
    );
  }
  if (isValidElement<ChildProps>(children)) {
    const props = children.props;
    const merged: ChildProps = {
      onPointerEnter: (e) => {
        props.onPointerEnter?.(e);
        handlers.onPointerEnter(e);
      },
      onPointerLeave: (e) => {
        props.onPointerLeave?.(e);
        handlers.onPointerLeave();
      },
      onPointerDown: (e) => {
        props.onPointerDown?.(e);
        handlers.onPointerDown();
      },
      onFocus: (e) => {
        props.onFocus?.(e);
        handlers.onFocus(e);
      },
      onBlur: (e) => {
        props.onBlur?.(e);
        handlers.onBlur();
      },
      "aria-describedby": anchor
        ? [props["aria-describedby"], tooltipId].filter(Boolean).join(" ")
        : props["aria-describedby"],
    };
    return (
      <>
        {cloneElement(children as ReactElement<ChildProps>, merged)}
        {card}
      </>
    );
  }
  // Fallback for text or several children: a layout-free wrapper.
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: layout-free wrapper; its children are the interactive elements and the handlers only observe them
    <span
      className="contents"
      onPointerEnter={handlers.onPointerEnter}
      onPointerLeave={handlers.onPointerLeave}
      onPointerDown={handlers.onPointerDown}
      onFocus={handlers.onFocus}
      onBlur={handlers.onBlur}
    >
      {children}
      {card}
    </span>
  );
}
EntityHover.displayName = "EntityHover";

/** A `display: contents` wrapper has no box; position against its first element instead. */
function target(el: Element): Element {
  const style = el instanceof HTMLElement ? el.style : null;
  if (el.classList.contains("contents") || style?.display === "contents") {
    return el.firstElementChild ?? el;
  }
  return el;
}

const GAP = 8;
const MARGIN = 8;

function HoverCard({
  id,
  entity,
  anchor,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: {
  id: string;
  entity: EntityRef;
  anchor: Element;
  onClose: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const { state, model } = useFlight();
  const ref = useRef<HTMLDivElement>(null);

  // Below the element, flipped above when there is no room, clamped to the viewport.
  const place = useCallback(() => {
    const card = ref.current;
    if (!card) return true;
    const a = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    if (!anchor.isConnected || a.bottom < 0 || a.top > vh || a.right < 0 || a.left > vw) {
      return false;
    }
    // Covered (under the sticky chrome, or scrolled out of its panel): close instead of floating
    // over whatever now hides the element.
    const cx = Math.min(vw - 1, Math.max(0, (a.left + a.right) / 2));
    const cy = Math.min(vh - 1, Math.max(0, (a.top + a.bottom) / 2));
    const hit = document.elementFromPoint(cx, cy);
    if (hit && !anchor.contains(hit) && !card.contains(hit)) return false;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    let top = a.bottom + GAP;
    if (top + h > vh - MARGIN && a.top - GAP - h >= MARGIN) top = a.top - GAP - h;
    top = Math.max(MARGIN, Math.min(top, vh - h - MARGIN));
    const left = Math.max(MARGIN, Math.min(a.left, vw - w - MARGIN));
    card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    card.style.visibility = "visible";
    return true;
  }, [anchor]);
  useLayoutEffect(() => {
    if (!place()) onClose();
  });

  // Escape closes the preview. A scroll or resize moves it with its element (keyboard focus
  // scrolls the element into view), and closes it once the element leaves the viewport.
  useEffect(() => {
    // Capture phase: Escape dismisses the preview first, before it clears the page selection.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    const onMove = () => {
      if (!place()) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [onClose, place]);

  const label = entityLabel(state, entity);
  const lines = previewLines(state, model, entity);
  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={{ visibility: "hidden" }}
      className="fixed top-0 left-0 z-50 grid w-[min(320px,calc(100vw-16px))] gap-1.5 bg-kumo-elevated px-3 py-2.5 text-[12px] shadow-md transition-opacity duration-[var(--rh-dur-overlay-in)] starting:opacity-0"
    >
      <p className="text-[12px] truncate text-kumo-subtle">{label.kicker}</p>
      <p className="line-clamp-2 text-[13px] font-semibold break-words">{label.title}</p>
      {lines.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-kumo-rule pt-1.5">
          {lines.map((line) => (
            <div key={line.label} className="contents">
              <dt className="text-kumo-subtle">{line.label}</dt>
              <dd className="min-w-0 break-words">{line.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
HoverCard.displayName = "HoverCard";

type Line = { label: string; value: ReactNode };

const clock = (at: number) => formatClock(new Date(at).toISOString());
const mono = (value: ReactNode) => <span className="font-mono text-[12px]">{value}</span>;
const keyOf = (state: FlightState, taskId: string | null | undefined) =>
  taskId ? (state.tasks[taskId]?.key ?? taskId) : "—";

function taskLines(state: FlightState, task: TaskState): Line[] {
  const run = task.running ?? task.runs.at(-1) ?? null;
  const provider = providerName(run?.provider ?? null);
  const lines: Line[] = [{ label: "Status", value: <StatusPill status={task.status} /> }];
  lines.push({
    label: "Model",
    value: run
      ? mono(
          `${run.tier}${provider ? ` · ${provider}` : ""} · attempt ${run.attempt}${run.escalatedFrom ? ` · from ${run.escalatedFrom}` : ""}`,
        )
      : "No attempt started",
  });
  if (task.running && state.live && task.running.lastStep) {
    lines.push({ label: "Step", value: truncate(task.running.lastStep, 90) });
  } else if (task.lastEvent) {
    lines.push({
      label: "Last",
      value: (
        <span>
          {mono(clock(task.lastEvent.at))} {truncate(task.lastEvent.detail, 90)}
        </span>
      ),
    });
  }
  if (task.blockedBy.length > 0) {
    lines.push({
      label: "Waits on",
      value: mono(task.blockedBy.map((id) => keyOf(state, id)).join(", ")),
    });
  }
  return lines;
}

function previewLines(state: FlightState, model: FlightModel, ref: EntityRef): Line[] {
  switch (ref.kind) {
    case "task": {
      const task = state.tasks[ref.id];
      return task ? taskLines(state, task) : [];
    }
    case "agent": {
      const task = taskOfAgent(state, ref.id);
      return task
        ? [{ label: "Task", value: mono(task.key) }, ...taskLines(state, task)]
        : [{ label: "Task", value: "Not assigned to a Task of this Change" }];
    }
    case "dependency": {
      const dep = state.dependencies.find((d) => d.id === ref.id);
      if (!dep) return [];
      return [
        { label: "Edge", value: mono(`${keyOf(state, dep.from)} → ${keyOf(state, dep.to)}`) },
        {
          label: "Status",
          value: (
            <StatusPill
              status={
                dep.status === "blocking"
                  ? "waiting"
                  : dep.status === "done"
                    ? "completed"
                    : dep.status
              }
            />
          ),
        },
        ...(dep.critical ? [{ label: "Path", value: "Critical path" }] : []),
      ];
    }
    case "candidate": {
      const c = state.candidates[ref.id];
      if (!c) return [];
      const required = c.checks.filter((x) => x.required);
      const supported = required.filter(
        (x) => x.status === "pass" && x.coverage === "checked_supported",
      ).length;
      const gaps = required.filter((x) => x.status === "pending" || x.coverage === "not_checked");
      return [
        { label: "Status", value: <StatusPill status={c.status} /> },
        ...(c.reason ? [{ label: "Reason", value: truncate(c.reason, 120) }] : []),
        {
          label: "Checks",
          value: `${formatNumber(supported)} / ${formatNumber(required.length)} required passed${gaps.length > 0 ? ` · ${formatNumber(gaps.length)} gap${gaps.length === 1 ? "" : "s"}` : ""}`,
        },
      ];
    }
    case "conflict": {
      const c = state.conflicts.find((x) => x.id === ref.id);
      if (!c) return [];
      return [
        { label: "Resource", value: mono(c.resource) },
        { label: "State", value: <StatusPill status={c.state} /> },
        { label: keyOf(state, c.taskIds[0]), value: truncate(c.statements[0], 110) },
        { label: keyOf(state, c.taskIds[1]), value: truncate(c.statements[1], 110) },
      ];
    }
    case "changeset": {
      const cs = model.changeSets[ref.id];
      const task = Object.values(state.tasks).find((t) =>
        t.changeSets.some((x) => x.id === ref.id),
      );
      if (!cs) return task ? [{ label: "Task", value: mono(task.key) }] : [];
      return [
        ...(task ? [{ label: "Task", value: mono(task.key) }] : []),
        { label: "Status", value: <StatusPill status={cs.status} /> },
        {
          label: "Diff",
          value: mono(
            `${formatNumber(cs.files.length)} file${cs.files.length === 1 ? "" : "s"} · +${formatNumber(cs.insertions)} −${formatNumber(cs.deletions)}`,
          ),
        },
      ];
    }
    case "file": {
      const f = state.files.find((x) => x.path === ref.id);
      if (!f) return [];
      const changed = f.touches.some((t) => t.kind === "changed");
      return [
        { label: "Tasks", value: mono(f.taskIds.map((id) => keyOf(state, id)).join(", ")) },
        {
          label: "Lines",
          value: changed
            ? mono(`+${formatNumber(f.adds)} −${formatNumber(f.dels)}`)
            : "Expected only",
        },
        ...(f.contended
          ? [{ label: "Overlap", value: `Changed by ${formatNumber(f.taskIds.length)} Tasks` }]
          : []),
      ];
    }
    case "resource": {
      const r = state.resources.find((x) => x.resource === ref.id);
      if (!r) return [];
      const holders = r.claimedBy.map((agentId) => taskOfAgent(state, agentId)?.key ?? agentId);
      return [
        {
          label: "Claims",
          value: holders.length > 0 ? mono(holders.join(", ")) : "No active Claim",
        },
        { label: "Tasks", value: mono(r.taskIds.map((id) => keyOf(state, id)).join(", ") || "—") },
        ...(r.conflictIds.length > 0
          ? [{ label: "Conflicts", value: formatNumber(r.conflictIds.length) }]
          : []),
        ...(r.protectedResource
          ? [{ label: "Invariant", value: "Named in a protected invariant" }]
          : []),
      ];
    }
    case "check": {
      const [candidateId = "", ...rest] = ref.id.split(":");
      const check = state.candidates[candidateId]?.checks.find((x) => x.checkId === rest.join(":"));
      if (!check) return [];
      const metrics = Object.entries(check.record?.metrics ?? {}).filter(
        ([k]) => k.toLowerCase().includes("p95") || k === "screenshots",
      );
      return [
        {
          label: "Status",
          value: (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <StatusPill
                status={check.coverage === "not_checked" ? "not_checked" : check.status}
              />
              <span className="text-kumo-subtle">
                {check.coverage ? check.coverage.replace(/_/g, " ") : "no Evidence yet"}
              </span>
            </span>
          ),
        },
        { label: "Gate", value: check.required ? "Required" : "Optional" },
        ...metrics.map(([k, v]) => ({
          label: k,
          value: mono(k.toLowerCase().includes("p95") ? `${formatNumber(v)} ms` : formatNumber(v)),
        })),
      ];
    }
    case "decision": {
      const d = state.decisions.find((x) => x.id === ref.id);
      if (!d) return [];
      return [
        { label: "Verdict", value: truncate(d.verdict, 140) },
        { label: "By", value: mono(d.by) },
        { label: "At", value: mono(clock(d.at)) },
      ];
    }
    case "event": {
      const e =
        state.events.find((x) => x.id === ref.id) ?? model.events.find((x) => x.id === ref.id);
      if (!e) return [];
      return [
        { label: "Type", value: mono(e.type) },
        { label: "At", value: mono(clock(e.at)) },
        ...(e.actor ? [{ label: "Actor", value: mono(e.actor) }] : []),
      ];
    }
  }
}
