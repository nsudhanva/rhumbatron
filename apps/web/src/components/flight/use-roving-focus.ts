import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * One-tab-stop composite widgets for dense plots (DESIGN.md 5.2 targets, 14 keyboard): a lane, a
 * heat grid or a detail list is ONE focusable element (a listbox or grid at least 24px tall) and
 * its markers or cells are items reached with the arrow keys through `aria-activedescendant`.
 * Items carry no tabindex, so they are neither tab stops nor separate pointer targets: a pointer
 * anywhere in the composite picks the nearest item within `snap` px (shown with `data-hot`) and a
 * click selects it. The effective pointer target is the composite region, not the 8px marker.
 *
 * Why not Base UI's internal Composite: it uses a roving tabindex, which leaves the active 8px
 * marker in the tab order (a WCAG 2.5.8 target), and it is not a public export.
 *
 *   const rv = useRovingFocus({ rows: [markerKeys], onActivate: (k) => toggle(refOf(k)) });
 *   <div role="listbox" aria-label="T01 facts" {...rv.containerProps}>
 *     {markers.map((m) => <div role="option" {...rv.itemProps(m.key)} />)}
 *   </div>
 *
 * Keys: Left/Right within a row; Up/Down to the nearest item (by x) in the next row, or across
 * to the next composite of the same `group` at an edge; Home/End within the row; Ctrl+Home/End
 * first/last; Enter or Space activates. Items need a stable string key.
 */

export type RovingMove =
  | "left"
  | "right"
  | "up"
  | "down"
  | "rowStart"
  | "rowEnd"
  | "first"
  | "last";

export type RovingStep = { key: string } | { edge: "up" | "down" } | null;

type Rows = readonly (readonly string[])[];

/** Row and column of `key`, or null. */
function locate(rows: Rows, key: string | null): [number, number] | null {
  if (key === null) return null;
  for (let r = 0; r < rows.length; r += 1) {
    const c = rows[r]?.indexOf(key) ?? -1;
    if (c >= 0) return [r, c];
  }
  return null;
}

/**
 * Pure keyboard step over `rows`. `pick(row, from)` chooses the item of another row to land on
 * (the panels pass the item nearest by x); without it the same column, clamped. Returns null when
 * the move does nothing, `{ edge }` when Up/Down runs past the first or last non-empty row.
 */
function step(
  rows: Rows,
  active: string | null,
  move: RovingMove,
  pick?: (row: readonly string[], from: [number, number]) => string | undefined,
): RovingStep {
  const filled = rows.map((row, i) => [i, row] as const).filter(([, row]) => row.length > 0);
  const firstRow = filled[0]?.[1];
  const lastRow = filled[filled.length - 1]?.[1];
  if (!firstRow || !lastRow) return null;
  const at = locate(rows, active);
  if (!at) {
    const key = move === "last" || move === "rowEnd" ? lastRow[lastRow.length - 1] : firstRow[0];
    return key === undefined ? null : { key };
  }
  const [r, c] = at;
  const row = rows[r] ?? [];
  const to = (key: string | undefined): RovingStep =>
    key === undefined || key === active ? null : { key };
  switch (move) {
    case "left":
      return to(row[c - 1]);
    case "right":
      return to(row[c + 1]);
    case "rowStart":
      return to(row[0]);
    case "rowEnd":
      return to(row[row.length - 1]);
    case "first":
      return to(firstRow[0]);
    case "last":
      return to(lastRow[lastRow.length - 1]);
    case "up":
    case "down": {
      const next =
        move === "up" ? [...filled].reverse().find(([i]) => i < r) : filled.find(([i]) => i > r);
      if (!next) return { edge: move };
      const target = next[1];
      return to(pick?.(target, at) ?? target[Math.min(c, target.length - 1)]);
    }
  }
}

const KEY_MOVES: Record<string, RovingMove> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  Home: "rowStart",
  End: "rowEnd",
};

/** Distance from a point to a box (0 inside). */
function boxDistance(rect: DOMRect, x: number, y: number) {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy);
}

const ITEM_ATTR = "data-roving-key";

function itemElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[${ITEM_ATTR}]`));
}

/** The item nearest to (x, y) within `snap` px; inside two boxes, the smaller one (a marker over a bar). */
function nearestItem(container: HTMLElement, x: number, y: number, snap: number): string | null {
  let best: { key: string; d: number; area: number } | null = null;
  for (const el of itemElements(container)) {
    const key = el.getAttribute(ITEM_ATTR);
    if (key === null) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const d = boxDistance(rect, x, y);
    if (d > snap) continue;
    const area = rect.width * rect.height;
    if (!best || d < best.d || (d === best.d && area < best.area)) best = { key, d, area };
  }
  return best?.key ?? null;
}

const centerX = (el: Element | null) => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.left + r.width / 2;
};

/** Composites of one group hand focus to each other at their Up/Down edges (agent lanes). */
const enterAt = new WeakMap<HTMLElement, (x: number | null) => void>();

export type RovingShow = "focus" | "pointer" | null;

export type RovingOptions = {
  /** Item keys by row, in reading order. A lane is one row; a heat grid is one row per file. */
  rows: Rows;
  /** Enter, Space or a click on an item (or near it). */
  onActivate: (key: string) => void;
  /** Where the active item starts on first focus (e.g. the item of the selected entity). */
  initial?: string | null;
  /** Composites that share a group pass focus between each other at their Up/Down edges. */
  group?: string;
  /** Pointer snap distance in px from an item's box. */
  snap?: number;
};

export function useRovingFocus({
  rows,
  onActivate,
  initial = null,
  group,
  snap = 16,
}: RovingOptions) {
  const base = useId();
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [active, setActiveState] = useState<string | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const [focus, setFocus] = useState<"none" | "pointer" | "keyboard">("none");
  const activeRef = useRef<string | null>(null);
  /** Key pressed with the pointer: no hover card until the pointer moves to another item. */
  const pressed = useRef<string | null>(null);
  const scrollOnChange = useRef(false);
  const activate = useRef(onActivate);
  activate.current = onActivate;

  // Callers may rebuild `rows` every render; the item set only changes when the keys do.
  const signature = rows.map((r) => r.join("\u001f")).join("\u001e");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the rows' content
  const all = useMemo(() => new Set(rows.flat()), [signature]);
  const itemId = useCallback((key: string) => `${base}-${key.replace(/\s+/g, "_")}`, [base]);

  const setActive = useCallback((key: string | null, scroll = false) => {
    activeRef.current = key;
    scrollOnChange.current = scroll;
    setActiveState(key);
  }, []);

  // Facts can disappear (time machine, filters): drop an active or hot item that is gone.
  useEffect(() => {
    if (activeRef.current !== null && !all.has(activeRef.current)) setActive(null);
    setHot((h) => (h !== null && !all.has(h) ? null : h));
  }, [all, setActive]);

  // Keep the keyboard-active item in view (lanes scroll sideways under a sticky left column).
  useEffect(() => {
    if (!scrollOnChange.current || active === null) return;
    scrollOnChange.current = false;
    document
      .getElementById(itemId(active))
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, itemId]);

  const firstKey = useCallback(() => {
    if (initial !== null && all.has(initial)) return initial;
    return rows.find((r) => r.length > 0)?.[0] ?? null;
  }, [initial, all, rows]);

  /** Lands on the item nearest to `x` (screen px), or the first one. */
  const enter = useCallback(
    (x: number | null) => {
      if (!el) return;
      let key: string | null = null;
      if (x !== null) {
        let best = Number.POSITIVE_INFINITY;
        for (const item of itemElements(el)) {
          const cx = centerX(item);
          const k = item.getAttribute(ITEM_ATTR);
          if (cx === null || k === null) continue;
          if (Math.abs(cx - x) < best) {
            best = Math.abs(cx - x);
            key = k;
          }
        }
      }
      setActive(key ?? firstKey(), true);
    },
    [el, firstKey, setActive],
  );

  useEffect(() => {
    if (!el) return;
    enterAt.set(el, enter);
    return () => {
      enterAt.delete(el);
    };
  }, [el, enter]);

  const crossGroup = (dir: "up" | "down") => {
    if (!group || !el) return;
    const peers = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-roving-group="${CSS.escape(group)}"]`),
    );
    const i = peers.indexOf(el);
    const next = peers[dir === "up" ? i - 1 : i + 1];
    if (i < 0 || !next) return;
    const from = activeRef.current
      ? centerX(document.getElementById(itemId(activeRef.current)))
      : null;
    enterAt.get(next)?.(from);
    next.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget || e.altKey || e.metaKey) return;
    setFocus("keyboard");
    if (e.key === "Enter" || e.key === " ") {
      const key = activeRef.current;
      if (key === null) return;
      e.preventDefault();
      activate.current(key);
      return;
    }
    let move = KEY_MOVES[e.key];
    if (!move) return;
    if (e.ctrlKey && move === "rowStart") move = "first";
    else if (e.ctrlKey && move === "rowEnd") move = "last";
    const pick = (row: readonly string[]) => {
      const from = activeRef.current
        ? centerX(document.getElementById(itemId(activeRef.current)))
        : null;
      if (from === null) return undefined;
      let best: string | undefined;
      let d = Number.POSITIVE_INFINITY;
      for (const key of row) {
        const cx = centerX(document.getElementById(itemId(key)));
        if (cx !== null && Math.abs(cx - from) < d) {
          d = Math.abs(cx - from);
          best = key;
        }
      }
      return best;
    };
    const next = step(rows, activeRef.current, move, pick);
    // Arrow keys are always ours inside the composite: they never scroll the page under it.
    e.preventDefault();
    if (!next) return;
    if ("edge" in next) crossGroup(next.edge);
    else setActive(next.key, true);
  };

  const onFocus = (e: FocusEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    setFocus(e.currentTarget.matches(":focus-visible") ? "keyboard" : "pointer");
    if (activeRef.current === null || !all.has(activeRef.current)) setActive(firstKey());
  };
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    if (e.target === e.currentTarget) setFocus("none");
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType === "touch") return;
    const key = nearestItem(e.currentTarget, e.clientX, e.clientY, snap);
    if (key !== null && key === pressed.current) return;
    pressed.current = null;
    setHot((h) => (h === key ? h : key));
  };
  const onPointerLeave = () => {
    pressed.current = null;
    setHot(null);
  };
  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    pressed.current = nearestItem(e.currentTarget, e.clientX, e.clientY, snap);
    setHot(null);
  };
  const onClick = (e: MouseEvent<HTMLElement>) => {
    const own = e.target instanceof Element ? e.target.closest(`[${ITEM_ATTR}]`) : null;
    const key =
      (own && e.currentTarget.contains(own) ? own.getAttribute(ITEM_ATTR) : null) ??
      nearestItem(e.currentTarget, e.clientX, e.clientY, snap);
    if (key === null) return;
    setActive(key);
    activate.current(key);
  };

  const focused = focus !== "none";
  const containerProps = {
    ref: setEl,
    tabIndex: 0,
    "aria-activedescendant": focused && active !== null ? itemId(active) : undefined,
    "data-roving-group": group,
    "data-hot": hot !== null ? "" : undefined,
    onKeyDown,
    onFocus,
    onBlur,
    onPointerMove,
    onPointerLeave,
    onPointerDown,
    onClick,
  };

  const itemProps = (key: string) => ({
    id: itemId(key),
    [ITEM_ATTR]: key,
    // The active ring is a focus indicator: keyboard only (DESIGN.md 10).
    "data-active": focus === "keyboard" && active === key ? "" : undefined,
    "data-hot": hot === key ? "" : undefined,
  });

  /** Hover-card mode for `key` (EntityHover `show`): pointer-near, keyboard-active, or none. */
  const show = (key: string): RovingShow =>
    hot === key ? "pointer" : focus === "keyboard" && active === key ? "focus" : null;

  return { active, hot, focused, containerProps, itemProps, itemId, show };
}

export type Roving = ReturnType<typeof useRovingFocus>;

/**
 * Item classes for the two states: the pointer-near item (ink ring) and the keyboard-active item
 * (accent focus ring, DESIGN.md 10), both outside the item so 8px markers stay legible.
 */
export const ROVING_ITEM =
  "data-[hot]:outline-1 data-[hot]:outline-offset-2 data-[hot]:outline-kumo-ink data-[active]:outline-2 data-[active]:outline-offset-2 data-[active]:outline-accent-500 data-[active]:z-[7]";

/** Container classes: keyboard focus ring inset on the composite, pointer cursor near an item. */
export const ROVING_CONTAINER =
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500 data-[hot]:cursor-pointer";
