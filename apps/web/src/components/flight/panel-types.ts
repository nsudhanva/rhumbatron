/**
 * Shared panel contract. Every Flight Control panel is a named export with this signature and is
 * loaded lazily by the page (flight-page.tsx) so the route's first paint stays small.
 *
 *   export function DagPanel({ focused }: PanelProps) { const { state } = useFlight(); ... }
 *
 * A panel renders inside a fixed-height frame the page provides (no layout shift while data
 * loads); when `focused` it fills the page and may grow. Wide content scrolls inside the panel,
 * never the page (DESIGN.md 6.3).
 */
export type PanelProps = {
  focused: boolean;
};
