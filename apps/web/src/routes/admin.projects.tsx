import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { formatDate } from "../components/admin/admin-format";
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
import { formatCost } from "../components/costs-page/cost-format";
import { SectionError, SkeletonRows } from "../components/project/feedback";
import { ProjectStatusPill } from "../components/project/status";
import { DataTable, Td, Th, TitleCell, TRow } from "../components/ui/data-table";
import { EmptyState } from "../components/ui/empty-state";
import { Section } from "../components/ui/page";
import { ADMIN_KEYS, listAdminProjects, type ProjectFilters } from "../lib/api-admin";
import { EMPTY, formatAge, formatNumber, generation } from "../lib/format";
import { loadForAdmin, prefetch } from "../lib/ssr-data";

const STATUSES = ["active", "archived"] as const;
const STATUS_ITEMS: Record<(typeof STATUSES)[number], string> = {
  active: "Active",
  archived: "Archived",
};

/** Admin Projects: every Project with its owner, members, generation, Changes and spend. */
export const Route = createFileRoute("/admin/projects")({
  validateSearch: (search: Record<string, unknown>): ProjectFilters =>
    cleanSearch({
      q: stringParam(search.q),
      ownerId: stringParam(search.ownerId),
      status: oneOf(search.status, STATUSES),
      cursor: stringParam(search.cursor, 400),
    }),
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) =>
    loadForAdmin(queryClient, () =>
      prefetch(queryClient, ADMIN_KEYS.projects(deps), () => listAdminProjects({ data: deps })),
    ),
  component: ProjectsPage,
});

function ProjectsPage() {
  return (
    <AdminPage title="Projects" trail={[{ label: "Projects" }]}>
      <Projects />
    </AdminPage>
  );
}

function Projects() {
  const search = Route.useSearch();
  const projects = useQuery({
    queryKey: ADMIN_KEYS.projects(search),
    queryFn: () => listAdminProjects({ data: search }),
  });
  const filtered = !!search.q || !!search.ownerId || !!search.status;
  const rows = projects.data?.projects ?? [];

  return (
    <Section
      label="Projects"
      meta={projects.data ? `${formatNumber(rows.length)} shown` : undefined}
    >
      <Filters key={JSON.stringify(search)} search={search} />
      {projects.isError ? (
        <SectionError
          message={`The Projects could not load. ${projects.error.message}`}
          onRetry={() => projects.refetch()}
          retrying={projects.isFetching}
        />
      ) : projects.data && rows.length === 0 ? (
        <EmptyState
          what={filtered ? "No Projects match these filters." : "No Projects yet."}
          how={
            filtered
              ? "Change the search, the owner or the status, or clear the filters."
              : "A Project appears here when a user creates one."
          }
        />
      ) : (
        <>
          <DataTable label="Projects" minWidth={1080}>
            <thead>
              <tr>
                <Th>Project</Th>
                <Th>Status</Th>
                <Th>Owner</Th>
                <Th numeric>Members</Th>
                <Th numeric>Generation</Th>
                <Th numeric>Changes</Th>
                <Th numeric>This month</Th>
                <Th numeric>All time</Th>
                <Th>Live app</Th>
                <Th numeric>Created</Th>
                <Th numeric>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {projects.data ? (
                rows.map((p) => (
                  <TRow key={p.projectId}>
                    <Td className="max-w-[240px]">
                      <TitleCell title={p.name} meta={`${p.slug} · ${p.projectId}`} />
                    </Td>
                    <Td>
                      <ProjectStatusPill status={p.status} />
                    </Td>
                    <Td className="max-w-[180px] truncate">
                      {p.owner ? (
                        <Link
                          to="/admin/users/$userId"
                          params={{ userId: p.owner.userId }}
                          className="text-kumo-link hover:underline"
                          title={p.owner.userId}
                        >
                          {p.owner.name ?? p.owner.userId}
                        </Link>
                      ) : (
                        EMPTY
                      )}
                    </Td>
                    <Td numeric>{formatNumber(p.members)}</Td>
                    <Td numeric>{generation(p.generation)}</Td>
                    <Td numeric>{formatNumber(p.changes)}</Td>
                    <Td numeric>{formatCost(p.spendMonthUsd)}</Td>
                    <Td numeric>{formatCost(p.spendAllTimeUsd)}</Td>
                    <Td className="max-w-[200px] truncate">
                      {p.liveAppUrl ? (
                        <a
                          href={p.liveAppUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-[12px] text-kumo-link hover:underline"
                          title={p.liveAppUrl}
                        >
                          {p.liveAppUrl.replace(/^https?:\/\//, "")}
                        </a>
                      ) : (
                        EMPTY
                      )}
                    </Td>
                    <Td numeric title={p.createdAt}>
                      {formatDate(p.createdAt)}
                    </Td>
                    <Td numeric title={p.updatedAt}>
                      {formatAge(p.updatedAt)}
                    </Td>
                  </TRow>
                ))
              ) : (
                <SkeletonRows
                  cells={[
                    "title",
                    60,
                    100,
                    "numeric",
                    "numeric",
                    "numeric",
                    "numeric",
                    "numeric",
                    120,
                    "numeric",
                    "numeric",
                  ]}
                />
              )}
            </tbody>
          </DataTable>
          {projects.data && (
            <Pager
              shown={rows.length}
              noun={rows.length === 1 ? "Project" : "Projects"}
              first={
                search.cursor
                  ? { to: "/admin/projects", search: { ...search, cursor: undefined } }
                  : undefined
              }
              next={
                projects.data.nextCursor
                  ? {
                      to: "/admin/projects",
                      search: { ...search, cursor: projects.data.nextCursor },
                    }
                  : undefined
              }
            />
          )}
        </>
      )}
    </Section>
  );
}

function Filters({ search }: { search: ProjectFilters }) {
  const navigate = useNavigate({ from: "/admin/projects" });
  const { draft, set } = useDraft({
    q: search.q,
    ownerId: search.ownerId,
    status: oneOf(search.status, STATUSES),
  });
  return (
    <FilterBar
      label="Filter Projects"
      active={!!search.q || !!search.ownerId || !!search.status}
      onApply={() =>
        navigate({
          search: cleanSearch({
            q: draft.q?.trim(),
            ownerId: draft.ownerId?.trim(),
            status: draft.status,
          }),
        })
      }
      onClear={() => navigate({ search: {} })}
    >
      <TextFilter
        label="Search"
        type="search"
        placeholder="Name or slug"
        value={draft.q}
        onChange={(v) => set("q", v)}
      />
      <TextFilter
        label="Owner user ID"
        placeholder="usr_…"
        value={draft.ownerId}
        onChange={(v) => set("ownerId", v)}
      />
      <SelectFilter
        label="Status"
        value={draft.status}
        onChange={(v) => set("status", v)}
        items={STATUS_ITEMS}
        allLabel="All Projects"
      />
    </FilterBar>
  );
}
