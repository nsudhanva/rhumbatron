import { cn } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { EMPTY } from "../../lib/format";

/**
 * Machine values: IDs, hashes, timestamps, paths, commands. Never re-cased.
 * `truncate` cuts at the end with an ellipsis and exposes the full value in `title`; an
 * identifier is never cut in the middle.
 *
 *   <Mono>{candidate.id}</Mono>
 *   <Mono truncate subtle>{artifactRef}</Mono>
 */
export function Mono({
  children,
  truncate,
  subtle,
  className,
}: {
  children: ReactNode;
  truncate?: boolean;
  subtle?: boolean;
  className?: string;
}) {
  const empty = children === null || children === undefined || children === "";
  return (
    <span
      title={truncate && typeof children === "string" ? children : undefined}
      className={cn(
        "font-mono text-[12px] tabular-nums",
        truncate && "inline-block max-w-full truncate align-bottom",
        subtle && "text-kumo-subtle",
        className,
      )}
    >
      {empty ? EMPTY : children}
    </span>
  );
}
Mono.displayName = "Mono";
