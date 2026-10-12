import { buttonVariants, cn } from "@cloudflare/kumo";
import { DownloadSimple } from "@phosphor-icons/react";
import { type AdminCosts, OTHER_CALLS_COST_KEY, UNATTRIBUTED_COST_KEY } from "@rhumbatron/protocol";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AdminPage } from "../components/admin/admin-page";
import {
  cleanSearch,
  dateParam,
  FilterBar,
  oneOf,
  SelectFilter,
  stringParam,
  TextFilter,
  useDraft,
} from "../components/admin/filters";
import { formatCost } from "../components/costs-page/cost-format";
import { SectionError, SkeletonRows } from "../components/project/feedback";
import { DataTable, RowLink, Td, Th, TitleCell, TRow } from "../components/ui/data-table";
import { EmptyState } from "../components/ui/empty-state";
import { Section } from "../components/ui/page";
import { StatCell, StatStrip } from "../components/ui/stat-strip";
import {
  ADMIN_KEYS,
  COST_GROUPS,
  type CostFilters,
  type CostGroup,
  getAdminCosts,
  queryString,
} from "../lib/api-admin";
import { formatNumber } from "../lib/format";
import { loadForAdmin, prefetch } from "../lib/ssr-data";

const GROUP_ITEMS: Record<CostGroup, string> = {
  user: "User",
  project: "Project",
  model: "Model",
  day: "Day",
};

/** The grouping when the URL names none. */
const DEFAULT_GROUP: CostGroup = "user";

/**
 * Admin Costs: recorded model spend over a date range, filtered by user and Project, grouped by
 * user, Project, model or day, with totals and a CSV download of the same view. User and Project
 * views read the monthly meters (whole months); model and day views read `task_runs`. The
 * "Not attributed" and "Other model calls" rows hold the rest of the environment meter, so the
 * rows add up to it; they show muted.
 */
export const Route = createFileRoute("/admin/costs")({
  validateSearch: (search: Record<string, unknown>): CostFilters =>
    cleanSearch({
      from: dateParam(search.from),
      to: dateParam(search.to),
      userId: stringParam(search.userId),
      projectId: stringParam(search.projectId),
      groupBy: oneOf(search.groupBy, COST_GROUPS),
    }),
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) =>
    loadForAdmin(queryClient, () =>
      prefetch(queryClient, ADMIN_KEYS.costs(withGroup(deps)), () =>
        getAdminCosts({ data: withGroup(deps) }),
      ),
    ),
  component: CostsPage,
});

const withGroup = (filters: CostFilters): CostFilters => ({
  ...filters,
  groupBy: filters.groupBy ?? DEFAULT_GROUP,
});

function CostsPage() {
  const search = Route.useSearch();
  const csvHref = `/admin-export/costs${queryString(withGroup(search))}`;
  return (
    <AdminPage
      title="Costs"
      trail={[{ label: "Costs" }]}
      actions={
        // A plain anchor: the CSV comes from a server route (routes/admin-export.costs.ts).
        <a
          href={csvHref}
          download
          className={cn(buttonVariants({ variant: "secondary" }), "gap-1.5")}
        >
          <DownloadSimple size={16} aria-hidden />
          Download CSV
        </a>
      }
    >
      <Costs />
    </AdminPage>
  );
}

/** Rows that no user, Project or `task_runs` row holds: the rest of a meter. */
const isRestRow = (key: string) => key === UNATTRIBUTED_COST_KEY || key === OTHER_CALLS_COST_KEY;

/** The API reads the last 30 UTC days when the view names no range (at most 366 days). */
function rangeText(filters: CostFilters): string {
  if (filters.from && filters.to) return `${filters.from} → ${filters.to} UTC`;
  if (filters.from) return `${filters.from} → today UTC`;
  if (filters.to) return `30 days to ${filters.to} UTC`;
  return "last 30 days UTC";
}

function Costs() {
  const search = Route.useSearch();
  const filters = withGroup(search);
  const costs = useQuery({
    queryKey: ADMIN_KEYS.costs(filters),
    queryFn: () => getAdminCosts({ data: filters }),
  });
  const data = costs.data;

  return (
    <>
      <Filters key={JSON.stringify(search)} search={search} />
      {costs.isError ? (
        <SectionError
          message={`The costs could not load. ${costs.error.message}`}
          onRetry={() => costs.refetch()}
          retrying={costs.isFetching}
        />
      ) : (
        <>
          <Totals data={data} range={data ? `${data.from} → ${data.to} UTC` : rangeText(filters)} />
          {data?.rows.some((row) => isRestRow(row.key)) && (
            <p className="text-[12px] text-kumo-subtle">
              Per-user and per-Project meters start on Oct 11, 2026. Earlier spend, and model calls
              that no request paid for, appear as Not attributed.
            </p>
          )}
          <Section
            label={`By ${GROUP_ITEMS[filters.groupBy ?? DEFAULT_GROUP].toLowerCase()}`}
            meta={data ? `${formatNumber(data.rows.length)} rows` : undefined}
          >
            {data && data.rows.length === 0 ? (
              <EmptyState
                what="No recorded spend in this view."
                how="Widen the date range or clear the user and Project filters."
              />
            ) : (
              <CostTable data={data} filters={filters} />
            )}
          </Section>
          {data && (
            <footer className="max-w-[760px] border-t border-kumo-rule pt-3 text-[12px] text-kumo-subtle">
              <span className="font-semibold">Source:</span> {data.source}
            </footer>
          )}
        </>
      )}
    </>
  );
}

function Totals({ data, range }: { data: AdminCosts | undefined; range: string }) {
  // A meter row has no call or token counts: the sum is empty when no row has one.
  const sum = (pick: (row: AdminCosts["rows"][number]) => number | null) => {
    const counts = (data?.rows ?? []).map(pick).filter((n): n is number => n !== null);
    return counts.length > 0 ? counts.reduce((total, n) => total + n, 0) : undefined;
  };
  return (
    <StatStrip>
      <StatCell
        label="Total spend"
        value={data ? formatCost(data.totalUsd) : "…"}
        footnote={range}
      />
      <StatCell label="Model calls" value={formatNumber(sum((r) => r.calls))} mono />
      <StatCell label="Input tokens" value={formatNumber(sum((r) => r.inputTokens))} mono />
      <StatCell label="Output tokens" value={formatNumber(sum((r) => r.outputTokens))} mono />
    </StatStrip>
  );
}

function CostTable({ data, filters }: { data: AdminCosts | undefined; filters: CostFilters }) {
  const group = filters.groupBy ?? DEFAULT_GROUP;
  return (
    <DataTable label="Costs" minWidth={720}>
      <thead>
        <tr>
          <Th>{GROUP_ITEMS[group]}</Th>
          <Th numeric>Spend</Th>
          <Th numeric>Share</Th>
          <Th numeric>Calls</Th>
          <Th numeric>Input</Th>
          <Th numeric>Output</Th>
        </tr>
      </thead>
      <tbody>
        {data ? (
          data.rows.map((row) => {
            const share = data.totalUsd > 0 ? (row.spendUsd / data.totalUsd) * 100 : 0;
            const rest = isRestRow(row.key);
            const label = group === "day" && !rest ? row.key : (row.label ?? row.key);
            return (
              <TRow key={row.key} className={rest ? "text-kumo-subtle" : ""}>
                <Td className="max-w-[320px]">
                  <TitleCell
                    title={
                      rest ? (
                        <span className="font-normal">{label}</span>
                      ) : (
                        <RowTitle group={group} rowKey={row.key} label={label} filters={filters} />
                      )
                    }
                    meta={group === "day" || rest || label === row.key ? undefined : row.key}
                  />
                </Td>
                <Td numeric>{formatCost(row.spendUsd)}</Td>
                <Td numeric>{`${formatNumber(share, 1)} %`}</Td>
                <Td numeric>{formatNumber(row.calls)}</Td>
                <Td numeric>{formatNumber(row.inputTokens)}</Td>
                <Td numeric>{formatNumber(row.outputTokens)}</Td>
              </TRow>
            );
          })
        ) : (
          <SkeletonRows cells={["title", "numeric", "numeric", "numeric", "numeric", "numeric"]} />
        )}
      </tbody>
    </DataTable>
  );
}

/**
 * A user row opens the user; a Project row narrows the view to that Project, grouped by user;
 * model and day rows are plain text.
 */
function RowTitle({
  group,
  rowKey,
  label,
  filters,
}: {
  group: CostGroup;
  rowKey: string;
  label: string;
  filters: CostFilters;
}) {
  if (group === "user") {
    return (
      <RowLink to="/admin/users/$userId" params={{ userId: rowKey }}>
        {label}
      </RowLink>
    );
  }
  if (group === "project") {
    return (
      <RowLink
        to="/admin/costs"
        search={cleanSearch({ ...filters, projectId: rowKey, groupBy: "user" as const })}
      >
        {label}
      </RowLink>
    );
  }
  return <span className="font-mono">{label}</span>;
}

function Filters({ search }: { search: CostFilters }) {
  const navigate = useNavigate({ from: "/admin/costs" });
  const { draft, set } = useDraft({ ...search });
  const active = !!(search.from || search.to || search.userId || search.projectId);
  return (
    <FilterBar
      label="Filter costs"
      active={active}
      onApply={() =>
        navigate({
          search: cleanSearch({
            from: dateParam(draft.from),
            to: dateParam(draft.to),
            userId: draft.userId?.trim(),
            projectId: draft.projectId?.trim(),
            groupBy: draft.groupBy,
          }),
        })
      }
      onClear={() => navigate({ search: cleanSearch({ groupBy: search.groupBy }) })}
    >
      <TextFilter
        label="From"
        type="date"
        value={draft.from}
        onChange={(v) => set("from", v)}
        className="w-[170px]"
      />
      <TextFilter
        label="To"
        type="date"
        value={draft.to}
        onChange={(v) => set("to", v)}
        className="w-[170px]"
      />
      <TextFilter
        label="User ID"
        placeholder="usr_…"
        value={draft.userId}
        onChange={(v) => set("userId", v)}
      />
      <TextFilter
        label="Project ID"
        placeholder="proj_…"
        value={draft.projectId}
        onChange={(v) => set("projectId", v)}
      />
      <SelectFilter
        label="Group by"
        value={draft.groupBy ?? DEFAULT_GROUP}
        onChange={(v) => set("groupBy", v)}
        items={GROUP_ITEMS}
        className="w-[140px]"
      />
    </FilterBar>
  );
}
