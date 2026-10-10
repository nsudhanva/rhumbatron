import { cn } from "@cloudflare/kumo";
import { CircleNotch } from "@phosphor-icons/react";

/**
 * Loader: a 16px CircleNotch that turns once per second (`.rh-spin` in theme.css). It is the
 * only looping motion in the default view: use it on running rows and loading states. Under
 * reduced motion it stays still and still reads as "working" next to its word. Use a progress
 * bar instead when the work has a known length. Inside a Kumo Button use `loading`.
 *
 *   <Loader /> <span>Planning</span>
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
      className={cn("inline-flex shrink-0 text-kumo-info", className)}
    >
      <CircleNotch size={size} aria-hidden className="rh-spin" />
    </span>
  );
}
Loader.displayName = "Loader";
