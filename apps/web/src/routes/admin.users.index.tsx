import type { AccessStatus } from "@rhumbatron/protocol";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AccessPill, formatDate } from "../components/admin/admin-format";
import { AdminPage } from "../components/admin/admin-page";
import {
  cleanSearch,
  FilterBar,
  oneOf,
  Pager,
  SelectFilter,
  stringParam,
  TextFilter,
  useDraft,
} from "../components/admin/filters";
import { SpendTotalsFoot } from "../components/admin/spend-totals";
import { formatCost } from "../components/costs-page/cost-format";
import { SectionError, SkeletonRows } from "../components/project/feedback";
import { DataTable, RowLink, Td, Th, TitleCell, TRow } from "../components/ui/data-table";
import { EmptyState } from "../components/ui/empty-state";
import { Section } from "../components/ui/page";
import { ADMIN_KEYS, listAdminUsers, type UserFilters } from "../lib/api-admin";
import { EMPTY, formatAge, formatNumber } from "../lib/format";
import { loadForAdmin, prefetch } from "../lib/ssr-data";

const STATUSES = ["approved", "pending", "declined"] as const;
const STATUS_ITEMS: Record<AccessStatus, string> = {
  approved: "Approved",
  pending: "Waiting",
  declined: "Declined",
};

/** Admin Users: every account with its access status, Projects, requests and spend. */
export const Route = createFileRoute("/admin/users/")({
  validateSearch: (search: Record<string, unknown>): UserFilters =>
    cleanSearch({
      q: stringParam(search.q),
      status: oneOf(search.status, STATUSES),
      cursor: stringParam(search.cursor, 400),
    }),
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) =>
    loadForAdmin(queryClient, () =>
      prefetch(queryClient, ADMIN_KEYS.users(deps), () => listAdminUsers({ data: deps })),
    ),
  component: UsersPage,
});

function UsersPage() {
  return (
    <AdminPage title="Users" trail={[{ label: "Users" }]}>
      <Users />
    </AdminPage>
  );
}

function Users() {
  const search = Route.useSearch();
  const users = useQuery({
    queryKey: ADMIN_KEYS.users(search),
    queryFn: () => listAdminUsers({ data: search }),
  });
  const filtered = !!search.q || !!search.status;
  const rows = users.data?.users ?? [];

  return (
    <Section label="Users" meta={users.data ? `${formatNumber(rows.length)} shown` : undefined}>
      <Filters key={JSON.stringify(search)} search={search} />
      {users.isError ? (
        <SectionError
          message={`The users could not load. ${users.error.message}`}
          onRetry={() => users.refetch()}
          retrying={users.isFetching}
        />
      ) : users.data && rows.length === 0 ? (
        <EmptyState
          what={filtered ? "No users match these filters." : "No users yet."}
          how={
            filtered
              ? "Change the search or the status, or clear the filters."
              : "A user appears here after their first sign-in."
          }
        />
      ) : (
        <>
          <DataTable label="Users" minWidth={980}>
            <thead>
              <tr>
                <Th>User</Th>
                <Th>Access</Th>
                <Th numeric>Projects</Th>
                <Th numeric>Requests</Th>
                <Th numeric>This month</Th>
                <Th numeric>All time</Th>
                <Th numeric>Budget</Th>
                <Th numeric>Joined</Th>
                <Th numeric>Last active</Th>
              </tr>
            </thead>
            <tbody>
              {users.data ? (
                rows.map((user) => (
                  <TRow key={user.userId} className="cursor-pointer">
                    <Td className="max-w-[300px]">
                      <TitleCell
                        title={
                          <RowLink to="/admin/users/$userId" params={{ userId: user.userId }}>
                            {user.name ?? user.email ?? user.userId}
                          </RowLink>
                        }
                        meta={user.email ?? user.userId}
                      />
                    </Td>
                    <Td>
                      <AccessPill status={user.accessStatus} />
                    </Td>
                    <Td numeric>{formatNumber(user.projects)}</Td>
                    <Td numeric>{formatNumber(user.requests)}</Td>
                    <Td numeric>{formatCost(user.spendMonthUsd)}</Td>
                    <Td numeric>{formatCost(user.spendAllTimeUsd)}</Td>
                    <Td numeric>
                      {user.monthlyBudgetUsd === null ? EMPTY : formatCost(user.monthlyBudgetUsd)}
                    </Td>
                    <Td numeric title={user.createdAt}>
                      {formatDate(user.createdAt)}
                    </Td>
                    <Td numeric title={user.lastActiveAt ?? undefined}>
                      {formatAge(user.lastActiveAt)}
                    </Td>
                  </TRow>
                ))
              ) : (
                <SkeletonRows
                  cells={[
                    "title",
                    60,
                    "numeric",
                    "numeric",
                    "numeric",
                    "numeric",
                    "numeric",
                    "numeric",
                    "numeric",
                  ]}
                />
              )}
            </tbody>
            {users.data && (
              <SpendTotalsFoot totals={users.data.totals} noun="users" before={4} after={3} />
            )}
          </DataTable>
          {users.data && (
            <Pager
              shown={rows.length}
              noun={rows.length === 1 ? "user" : "users"}
              first={
                search.cursor
                  ? { to: "/admin/users", search: { ...search, cursor: undefined } }
                  : undefined
              }
              next={
                users.data.nextCursor
                  ? { to: "/admin/users", search: { ...search, cursor: users.data.nextCursor } }
                  : undefined
              }
            />
          )}
        </>
      )}
    </Section>
  );
}

function Filters({ search }: { search: UserFilters }) {
  const navigate = useNavigate({ from: "/admin/users/" });
  const { draft, set } = useDraft({ q: search.q, status: search.status });
  return (
    <FilterBar
      label="Filter users"
      active={!!search.q || !!search.status}
      onApply={() =>
        navigate({ search: cleanSearch({ q: draft.q?.trim(), status: draft.status }) })
      }
      onClear={() => navigate({ search: {} })}
    >
      <TextFilter
        label="Search"
        type="search"
        placeholder="Name or email"
        value={draft.q}
        onChange={(v) => set("q", v)}
      />
      <SelectFilter
        label="Access"
        value={draft.status}
        onChange={(v) => set("status", v)}
        items={STATUS_ITEMS}
        allLabel="All users"
      />
    </FilterBar>
  );
}
