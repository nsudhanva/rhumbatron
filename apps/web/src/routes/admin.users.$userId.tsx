import type { AdminUserDetail } from "@rhumbatron/protocol";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AccessPill, formatDate } from "../components/admin/admin-format";
import { AdminPage } from "../components/admin/admin-page";
import { BarList } from "../components/costs-page/charts";
import { formatCost } from "../components/costs-page/cost-format";
import { SectionError, SkeletonBar } from "../components/project/feedback";
import { DataTable, Td, Th, TitleCell, TRow } from "../components/ui/data-table";
import { EmptyState } from "../components/ui/empty-state";
import { Mono } from "../components/ui/mono";
import { Section, TwoUp } from "../components/ui/page";
import { StatCell, StatStrip } from "../components/ui/stat-strip";
import { StatusPill } from "../components/ui/status-pill";
import { ADMIN_KEYS, getAdminUser } from "../lib/api-admin";
import { monthName } from "../lib/api-budget";
import { EMPTY, formatAge, formatNumber } from "../lib/format";
import { loadForAdmin, prefetch } from "../lib/ssr-data";

/**
 * Admin user detail: the account, its Projects with this month's spend, its recent requests and
 * its spend per month. Read-only; access decisions are on the Access page.
 */
export const Route = createFileRoute("/admin/users/$userId")({
  loader: ({ context: { queryClient }, params: { userId } }) =>
    loadForAdmin(queryClient, () =>
      prefetch(queryClient, ADMIN_KEYS.user(userId), () => getAdminUser({ data: userId })),
    ),
  component: UserPage,
});

function UserPage() {
  const { userId } = Route.useParams();
  const user = useQuery({
    queryKey: ADMIN_KEYS.user(userId),
    queryFn: () => getAdminUser({ data: userId }),
  });
  const data = user.data;
  const name = data ? (data.name ?? data.email ?? data.userId) : "User";
  return (
    <AdminPage
      title={name}
      trail={[
        { label: "Users", link: { to: "/admin/users" } },
        { label: data?.name ?? userId, mono: !data?.name },
      ]}
      meta={
        data ? (
          <>
            <AccessPill status={data.accessStatus} />
            {data.email && <Mono>{data.email}</Mono>}
            <Mono subtle>{data.userId}</Mono>
          </>
        ) : undefined
      }
    >
      {user.isError ? (
        <SectionError
          message={`This user could not load. ${user.error.message}`}
          onRetry={() => user.refetch()}
          retrying={user.isFetching}
        />
      ) : data ? (
        <UserDetail user={data} />
      ) : (
        <div className="grid gap-2" role="status" aria-label="Loading the user">
          <SkeletonBar height={15} className="w-1/2" />
          <SkeletonBar height={13} className="w-1/3" />
        </div>
      )}
    </AdminPage>
  );
}

function UserDetail({ user }: { user: AdminUserDetail }) {
  return (
    <>
      <StatStrip>
        <StatCell label="This month" value={formatCost(user.spendMonthUsd)} />
        <StatCell label="All time" value={formatCost(user.spendAllTimeUsd)} />
        <StatCell
          label="Monthly budget"
          value={user.monthlyBudgetUsd === null ? EMPTY : formatCost(user.monthlyBudgetUsd)}
          footnote={user.monthlyBudgetUsd === null ? "no personal budget" : undefined}
        />
        <StatCell
          label="Requests"
          value={formatNumber(user.requests)}
          footnote={`joined ${formatDate(user.createdAt)} · active ${formatAge(user.lastActiveAt)}`}
        />
      </StatStrip>

      <TwoUp>
        <Section
          label="Monthly spend"
          meta={
            <Link
              to="/admin/costs"
              search={{ userId: user.userId, groupBy: "project" }}
              className="text-kumo-link hover:underline"
            >
              Costs
            </Link>
          }
        >
          {user.monthly.length === 0 ? (
            <EmptyState what="No recorded spend." how="Spend appears after the first request." />
          ) : (
            <BarList
              items={user.monthly.map((m) => ({
                label: monthName(m.month),
                value: m.spendUsd,
                text: formatCost(m.spendUsd),
              }))}
            />
          )}
        </Section>

        <Section label="Projects" meta={`${formatNumber(user.projects.length)}`}>
          {user.projects.length === 0 ? (
            <EmptyState what="No Projects." how="The user has not created or joined a Project." />
          ) : (
            <DataTable label="Projects of this user" minWidth={420}>
              <thead>
                <tr>
                  <Th>Project</Th>
                  <Th>Role</Th>
                  <Th numeric>This month</Th>
                </tr>
              </thead>
              <tbody>
                {user.projects.map((p) => (
                  <TRow key={p.projectId}>
                    <Td className="max-w-[260px]">
                      <TitleCell title={p.name} meta={p.projectId} />
                    </Td>
                    <Td className="capitalize">{p.role}</Td>
                    <Td numeric>{formatCost(p.spendUsd)}</Td>
                  </TRow>
                ))}
              </tbody>
            </DataTable>
          )}
        </Section>
      </TwoUp>

      <Section
        label="Recent requests"
        meta={
          <Link
            to="/admin/events"
            search={{ userId: user.userId }}
            className="text-kumo-link hover:underline"
          >
            Events
          </Link>
        }
      >
        {user.recentChanges.length === 0 ? (
          <EmptyState
            what="No requests yet."
            how="Requests appear when the user starts a Change."
          />
        ) : (
          <DataTable label="Recent requests" minWidth={760}>
            <thead>
              <tr>
                <Th>Request</Th>
                <Th>Project</Th>
                <Th>Status</Th>
                <Th numeric>Spend</Th>
                <Th numeric>Created</Th>
              </tr>
            </thead>
            <tbody>
              {user.recentChanges.map((c) => (
                <TRow key={c.changeId}>
                  <Td className="max-w-[360px]">
                    <TitleCell title={c.title || c.changeId} meta={c.changeId} />
                  </Td>
                  <Td className="max-w-[200px] truncate">{c.projectName}</Td>
                  <Td>
                    <StatusPill status={c.status} />
                  </Td>
                  <Td numeric>{formatCost(c.spendUsd)}</Td>
                  <Td numeric title={c.createdAt}>
                    {formatAge(c.createdAt)}
                  </Td>
                </TRow>
              ))}
            </tbody>
          </DataTable>
        )}
      </Section>
    </>
  );
}
