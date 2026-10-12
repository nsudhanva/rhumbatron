import { useEffect, useState } from "react";

/**
 * Motion tokens for code that times things in JavaScript.
 * The same values live as CSS variables in theme.css (`--rh-dur-*`, `--rh-agent-cadence`);
 * keep both in sync. Prefer the CSS classes (`rh-fork`, `rh-packet`, `rh-arrive`, ...) for the
 * animation itself and use these numbers only to pace or sequence real events.
 */
export const MOTION = {
  uiMs: 150,
  overlayInMs: 160,
  barMs: 800,
  forkMs: 280,
  packetMs: 560,
  arriveMs: 600,
  greyoutMs: 320,
  mergeMs: 320,
  /** Spacing between replayed agent events so a viewer can follow a burst (150-250ms). */
  agentCadenceMs: 200,
} as const;

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * True when the user asks for reduced motion. Agent-activity views then render each state as
 * an instant transition and show the event list beside the view. False during SSR.
 */
export function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(REDUCE_QUERY);
    setReduce(query.matches);
    const onChange = () => setReduce(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduce;
}
