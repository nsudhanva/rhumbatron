import type { AdminSpendTotals } from "@rhumbatron/protocol";
import { formatCost } from "../costs-page/cost-format";
import { Td } from "../ui/data-table";

/**
 * Footer rows of the admin Users and Projects tables, for every row of the list (all pages, any
 * filter): the sum of the meters of the list, the spend that none of these meters holds ("Not
 * attributed"), and their sum, which is the environment meter (the model spend of the Overview).
 * `before` and `after` are the numbers of columns left and right of the two spend columns.
 */
export function SpendTotalsFoot({
  totals,
  noun,
  before,
  after,
}: {
  totals: AdminSpendTotals;
  noun: string;
  before: number;
  after: number;
}) {
  const rows = [
    {
      label: `All ${noun}`,
      note: "every page, any filter",
      month: totals.monthUsd,
      allTime: totals.allTimeUsd,
      className: "font-semibold",
    },
    {
      label: "Not attributed",
      note: "spend before Oct 11, 2026, and model calls that no request paid for",
      month: totals.unattributedMonthUsd,
      allTime: totals.unattributedAllTimeUsd,
      className: "text-kumo-subtle",
    },
    {
      label: "All model spend",
      note: "the environment meter",
      month: totals.monthUsd + totals.unattributedMonthUsd,
      allTime: totals.allTimeUsd + totals.unattributedAllTimeUsd,
      className: "font-semibold",
    },
  ];
  return (
    <tfoot>
      {rows.map((row) => (
        <tr key={row.label} className={row.className}>
          <Td colSpan={before}>
            <span className="grid min-w-0">
              <span className="truncate">{row.label}</span>
              <span className="truncate text-[12px] font-normal text-kumo-subtle">{row.note}</span>
            </span>
          </Td>
          <Td numeric className={row.className}>
            {formatCost(row.month)}
          </Td>
          <Td numeric className={row.className}>
            {formatCost(row.allTime)}
          </Td>
          {after > 0 && <Td colSpan={after} />}
        </tr>
      ))}
    </tfoot>
  );
}
SpendTotalsFoot.displayName = "SpendTotalsFoot";
