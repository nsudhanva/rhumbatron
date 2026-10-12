import { cn } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { EMPTY } from "../../lib/format";

export type KeyValueItem = {
  label: string;
  value: ReactNode;
  /** Machine-generated values (IDs, hashes, refs) render in mono and break anywhere. */
  mono?: boolean;
};

/**
 * Key-value grid: `auto 1fr`, 12px, keys subtle, values default. Empty values
 * render as an em dash.
 *
 *   <KeyValue items={[
 *     { label: "Base", value: "S1841", mono: true },
 *     { label: "Budget", value: formatUsd(change.budgetUsd) },
 *   ]} />
 */
export function KeyValue({ items, className }: { items: KeyValueItem[]; className?: string }) {
  return (
    <dl
      className={cn("grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12px]", className)}
    >
      {items.map((item) => {
        const empty = item.value === null || item.value === undefined || item.value === "";
        return (
          <div key={item.label} className="contents">
            <dt className="text-kumo-subtle">{item.label}</dt>
            <dd className={cn("min-w-0", item.mono && "font-mono break-all tabular-nums")}>
              {empty ? EMPTY : item.value}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
KeyValue.displayName = "KeyValue";
