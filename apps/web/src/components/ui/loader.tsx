import { cn } from "@cloudflare/kumo";

/**
 * Loader (DESIGN.md 8.5): a square that fills with ink in a loop, never a spinning circle.
 * Under reduced motion it shows a static half fill. Use a progress bar instead when the work
 * has a known length. Kumo's own Loader (inside `<Button loading>`) is restyled to match in
 * theme.css, so either is fine; use this one outside Kumo components.
 *
 *   <Loader /> <span>Compiling the Work Graph</span>
 */
export function Loader({
  size = 16,
  label = "Loading",
  className,
}: {
  size?: number;
  label?: string;
  className?: string;
}) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn("rh-loader", className)}
      style={{ width: size, height: size }}
    />
  );
}
Loader.displayName = "Loader";
