import { cn } from "@cloudflare/kumo";
import type { ReactNode } from "react";

/**
 * Empty state: flush left inside its section, one sentence on what would
 * appear, one on how to make it appear, and an optional secondary action. No illustration.
 *
 *   <EmptyState
 *     what="No Changes yet."
 *     how="Describe a goal below to start the first Change."
 *     action={<Button size="sm">New Change</Button>}
 *   />
 */
export function EmptyState({
  what,
  how,
  action,
  className,
}: {
  what: ReactNode;
  how?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid justify-items-start gap-3 py-3", className)}>
      <p className="max-w-[760px] text-[14px]">
        <span className="font-semibold">{what}</span>
        {how && <span className="text-kumo-subtle"> {how}</span>}
      </p>
      {action}
    </div>
  );
}
EmptyState.displayName = "EmptyState";
