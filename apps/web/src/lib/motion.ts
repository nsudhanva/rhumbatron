import { useEffect, useState } from "react";

/**
 * Motion tokens for code that times things in JavaScript. The same values live as CSS variables
 * in theme.css section 7 (`--rh-dur-ui`, `--rh-dur-overlay-in`, `--rh-dur-bar`); keep both in
 * sync. UI motion stays quiet: hover and overlays 120-180ms, progress bars 300ms.
 */
export const MOTION = {
  uiMs: 150,
  overlayInMs: 160,
  barMs: 300,
} as const;

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * True when the user asks for reduced motion: render state changes instantly and skip
 * scroll animations. False during SSR.
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
