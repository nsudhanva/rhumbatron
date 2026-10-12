import { type RefObject, useLayoutEffect, useRef } from "react";
import { MOTION } from "../../lib/motion";

/**
 * Layout animation for cards that move between columns (DESIGN.md 11): after a render that
 * changes `layoutKey`, each `[data-flip-id]` element that moved slides from its old place to the
 * new one (ease-out, the fork duration). Positions are measured inside the scrolling `container`,
 * so a page or board scroll between renders never reads as a move. A card that appears for the
 * first time settles in place. Under reduced motion nothing moves; cards change place at once.
 */
export function useFlip(
  container: RefObject<HTMLElement | null>,
  layoutKey: string,
  reduce: boolean,
) {
  const previous = useRef<Map<string, { x: number; y: number }> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the card layout changes
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const origin = root.getBoundingClientRect();
    const next = new Map<string, { x: number; y: number }>();
    const before = previous.current;
    for (const node of root.querySelectorAll<HTMLElement>("[data-flip-id]")) {
      const id = node.dataset.flipId;
      if (!id) continue;
      const rect = node.getBoundingClientRect();
      const at = {
        x: rect.left - origin.left + root.scrollLeft,
        y: rect.top - origin.top + root.scrollTop,
      };
      next.set(id, at);
      if (reduce || !before || typeof node.animate !== "function") continue;
      const from = before.get(id);
      if (!from) {
        node.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: MOTION.forkMs,
          easing: "ease-out",
        });
        continue;
      }
      const dx = from.x - at.x;
      const dy = from.y - at.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      node.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: MOTION.forkMs, easing: "ease-out" },
      );
    }
    previous.current = next;
  }, [layoutKey, reduce]);
}
