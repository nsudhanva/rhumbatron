import { Collapsible, cn } from "@cloudflare/kumo";
import { CaretRight } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/**
 * Progressive disclosure (DESIGN.md 9.15, 16 "raw evidence one click from any summary"): a
 * closed row with a caret, a label and an optional mono meta on the right. The panel holds the
 * detail a reader needs only on purpose: IDs, hashes, receipts, full tables.
 */
export function Disclosure({
  label,
  meta,
  children,
  defaultOpen = false,
  className,
  panelClassName,
}: {
  label: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  panelClassName?: string;
}) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className={cn("min-w-0", className)}>
      <Collapsible.Trigger className="group grid w-full cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-2 py-1.5 text-left text-[13px] transition-colors duration-(--rh-dur-ui) hover:bg-kumo-row-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500">
        <CaretRight
          size={14}
          aria-hidden
          className="text-kumo-subtle transition-transform duration-(--rh-dur-ui) group-data-[panel-open]:rotate-90"
        />
        <span className="min-w-0 font-semibold">{label}</span>
        {meta ? (
          <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">{meta}</span>
        ) : (
          <span />
        )}
      </Collapsible.Trigger>
      <Collapsible.Panel className={cn("grid gap-4 pt-2 pb-3 pl-6", panelClassName)}>
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
Disclosure.displayName = "Disclosure";
