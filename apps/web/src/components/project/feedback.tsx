import { Button, cn } from "@cloudflare/kumo";
import { WarningCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/**
 * Section error (DESIGN.md 8.5, 10): a danger banner inside the section, 13px 600 text with a
 * 16px leading icon and an optional retry as a secondary button that takes the text color.
 * Blocking errors are announced assertively (section 14).
 *
 *   <SectionError message={query.error.message} onRetry={() => query.refetch()} />
 */
export function SectionError({
  message,
  onRetry,
  retrying,
  className,
}: {
  message: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 bg-kumo-danger-tint px-3.5 py-2.5 text-[13px] font-semibold text-kumo-danger",
        className,
      )}
    >
      <p className="flex min-w-0 items-start gap-2">
        <WarningCircle size={16} aria-hidden className="mt-px shrink-0" />
        <span className="min-w-0 break-words">{message}</span>
      </p>
      {onRetry && (
        <Button
          size="sm"
          variant="secondary"
          loading={retrying ?? false}
          onClick={onRetry}
          className="border-current text-current"
        >
          Retry
        </Button>
      )}
    </div>
  );
}
SectionError.displayName = "SectionError";

/** One skeleton bar at the height of the text it replaces (11, 13 or 15px). */
export function SkeletonBar({
  height = 13,
  width,
  className,
}: {
  height?: number;
  width?: number;
  className?: string;
}) {
  return <span aria-hidden className={cn("skeleton block", className)} style={{ height, width }} />;
}
SkeletonBar.displayName = "SkeletonBar";

/**
 * Skeleton table rows for a first load (DESIGN.md 8.5): the real cells, rules and padding with
 * recessed bars in place of text. `cells` lists one entry per column: `title` draws the
 * two-line first column, `numeric` right-aligns a short bar, a number sets the bar width in px.
 */
export type SkeletonCell = "title" | "numeric" | number;

export function SkeletonRows({ cells, rows = 3 }: { cells: SkeletonCell[]; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity
        <tr key={row} aria-hidden>
          {cells.map((cell, index) => (
            <td
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholder cells have no identity
              key={index}
              className="border-b border-kumo-rule p-2 align-middle"
            >
              {cell === "title" ? (
                <span className="grid gap-1.5">
                  <SkeletonBar height={13} className="w-[min(60%,320px)]" />
                  <SkeletonBar height={11} className="w-[min(35%,180px)]" />
                </span>
              ) : cell === "numeric" ? (
                <SkeletonBar height={11} className="ml-auto w-12" />
              ) : (
                <SkeletonBar height={13} width={cell} className="max-w-full" />
              )}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
SkeletonRows.displayName = "SkeletonRows";
