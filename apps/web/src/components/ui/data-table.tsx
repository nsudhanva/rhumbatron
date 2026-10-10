import { cn } from "@cloudflare/kumo";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";

/**
 * Data table (DESIGN.md 8.3). Headers 11px uppercase in `subtle` over a 2px divider; cells 8px
 * padding over a 1px rule; no vertical lines; numbers right-aligned mono; pills left-aligned.
 * The wrapper scrolls sideways and the table keeps `minWidth`, so columns never squeeze.
 *
 *   <DataTable minWidth={720} label="Candidates">
 *     <thead><tr><Th>Candidate</Th><Th>Status</Th><Th numeric>p95</Th></tr></thead>
 *     <tbody>
 *       {rows.map((c) => (
 *         <TRow key={c.id} selected={c.id === currentId}>
 *           <Td><TitleCell title={<RowLink to="/candidates/$candidateId" params={{ candidateId: c.id }}>{c.name}</RowLink>} meta={c.id} /></Td>
 *           <Td><StatusPill status={c.status} /></Td>
 *           <Td numeric>{formatMs(c.p95)}</Td>
 *         </TRow>
 *       ))}
 *     </tbody>
 *   </DataTable>
 *
 * The whole row is the target: put one `RowLink` in the row; it stretches over the row. Other
 * buttons in the row need `relative z-10` so they stay clickable above the link.
 */
export function DataTable({
  children,
  minWidth = 640,
  label,
  className,
}: {
  children: ReactNode;
  minWidth?: number;
  /** Accessible name (rendered as a visually hidden caption). */
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 overflow-x-auto", className)}>
      <table className="w-full border-collapse text-left text-[13px]" style={{ minWidth }}>
        {label && <caption className="sr-only">{label}</caption>}
        {children}
      </table>
    </div>
  );
}
DataTable.displayName = "DataTable";

export function Th({
  numeric,
  className,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        "type-label border-b-2 border-kumo-divider p-2 align-bottom whitespace-nowrap text-kumo-subtle",
        numeric && "text-right",
        className,
      )}
      {...props}
    />
  );
}
Th.displayName = "Th";

export function Td({
  numeric,
  className,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={cn(
        "border-b border-kumo-rule p-2 align-middle",
        numeric && "text-right font-mono text-[12px] whitespace-nowrap tabular-nums",
        className,
      )}
      {...props}
    />
  );
}
Td.displayName = "Td";

/** Table row. `selected` adds the faint fill and the 2px accent bar on the left edge. */
export function TRow({
  selected,
  children,
  className,
}: {
  selected?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <tr
      data-selected={selected || undefined}
      className={cn(
        "relative transition-colors duration-(--rh-dur-ui) hover:bg-kumo-row-hover",
        selected && "bg-kumo-faint shadow-[inset_2px_0_0_var(--color-accent-500)]",
        className,
      )}
    >
      {children}
    </tr>
  );
}
TRow.displayName = "TRow";

/** First-column cell content: a 600 title over an 11px mono meta line. */
export function TitleCell({ title, meta }: { title: ReactNode; meta?: ReactNode }) {
  return (
    <div className="grid min-w-0">
      <span className="truncate font-semibold">{title}</span>
      {meta && (
        <span className="truncate font-mono text-[11px] text-kumo-subtle tabular-nums">{meta}</span>
      )}
    </div>
  );
}
TitleCell.displayName = "TitleCell";

/** A router link that makes its whole table row (or list row) the click target. */
export function RowLink({
  children,
  className,
  ...link
}: LinkOptions & { children: ReactNode; className?: string }) {
  return (
    <Link
      activeOptions={{ exact: true }}
      {...link}
      className={cn(
        "after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-[-2px] focus-visible:after:outline-accent-500",
        className,
      )}
    >
      {children}
    </Link>
  );
}
RowLink.displayName = "RowLink";
