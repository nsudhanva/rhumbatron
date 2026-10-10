import { cn } from "@cloudflare/kumo";
import { CaretRight } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/**
 * A closed native disclosure for internal names, IDs and hashes (spec 6.2 P9, common rule 9).
 * The default view stays plain; developers open it when they need the machinery.
 */
export function TechnicalDetails({
  children,
  label = "Technical details",
  open,
  className,
}: {
  children: ReactNode;
  label?: ReactNode;
  open?: boolean;
  className?: string;
}) {
  return (
    <details open={open} className={cn("group text-[12px] text-kumo-subtle", className)}>
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-accent-500 [&::-webkit-details-marker]:hidden">
        <CaretRight
          size={12}
          aria-hidden
          className="transition-transform duration-150 group-open:rotate-90"
        />
        {label}
      </summary>
      <div className="pt-2 text-kumo-default">{children}</div>
    </details>
  );
}
TechnicalDetails.displayName = "TechnicalDetails";
