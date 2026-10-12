import { cn } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { formatDateTime } from "../components/admin/admin-format";
import { AdminPage } from "../components/admin/admin-page";
import {
  cleanSearch,
  dateParam,
  FilterBar,
  Pager,
  stringParam,
  TextFilter,
  useDraft,
} from "../components/admin/filters";
import { SectionError, SkeletonRows } from "../components/project/feedback";
import { DataTable, Td, Th, TRow } from "../components/ui/data-table";
import { EmptyState } from "../components/ui/empty-state";
import { Mono } from "../components/ui/mono";
import { Section } from "../components/ui/page";
import { ADMIN_KEYS, type EventFilters, listAdminEvents } from "../lib/api-admin";
import { EMPTY, formatNumber } from "../lib/format";
import { loadForAdmin, prefetch } from "../lib/ssr-data";

/** An event type filter: lowercase letters, digits, `_` and `.`, as the API accepts. */
const eventTypeParam = (value: unknown) => {
  const type = stringParam(value, 80)?.toLowerCase();
  return type && /^[a-z0-9_.]+$/.test(type) ? type : undefined;
};

/** Admin Events: recorded Project events across every Project, newest first, with paging. */
export const Route = createFileRoute("/admin/events")({
  validateSearch: (search: Record<string, unknown>): EventFilters =>
    cleanSearch({
      userId: stringParam(search.userId),
      projectId: stringParam(search.projectId),
      type: eventTypeParam(search.type),
      from: dateParam(search.from),
      to: dateParam(search.to),
      cursor: stringParam(search.cursor, 400),
    }),
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) =>
    loadForAdmin(queryClient, () =>
      prefetch(queryClient, ADMIN_KEYS.events(deps), () => listAdminEvents({ data: deps })),
    ),
  component: EventsPage,
});

function EventsPage() {
  return (
    <AdminPage title="Events" trail={[{ label: "Events" }]}>
      <Events />
    </AdminPage>
  );
}

/** Event type color: failure in danger, completion in success, the rest in default. */
function typeClass(eventType: string): string | undefined {
  if (/(failed|rejected|stale|expired|dead)/.test(eventType)) return "text-kumo-danger";
  if (/(completed|advanced|promoted|granted|accepted)/.test(eventType)) return "text-kumo-success";
  return undefined;
}

function Events() {
  const search = Route.useSearch();
  const events = useQuery({
    queryKey: ADMIN_KEYS.events(search),
    queryFn: () => listAdminEvents({ data: search }),
  });
  const filtered = !!(search.userId || search.projectId || search.type || search.from || search.to);
  const rows = events.data?.events ?? [];

  return (
    <Section label="Events" meta={events.data ? "newest first" : undefined}>
      <Filters key={JSON.stringify(search)} search={search} />
      {events.isError ? (
        <SectionError
          message={`The events could not load. ${events.error.message}`}
          onRetry={() => events.refetch()}
          retrying={events.isFetching}
        />
      ) : events.data && rows.length === 0 ? (
        <EmptyState
          what={filtered ? "No events match these filters." : "No events yet."}
          how={
            filtered
              ? "Widen the date range, change the type, or clear the filters."
              : "Events appear when people start Changes in their Projects."
          }
        />
      ) : (
        <>
          <DataTable label="Events, newest first" minWidth={1000}>
            <thead>
              <tr>
                <Th numeric>Seq</Th>
                <Th>Time</Th>
                <Th>Type</Th>
                <Th>Project</Th>
                <Th>Actor</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {events.data ? (
                rows.map((e) => (
                  <TRow key={`${e.projectId}:${e.seq}`}>
                    <Td numeric>{formatNumber(e.seq)}</Td>
                    <Td className="font-mono text-[12px] whitespace-nowrap tabular-nums">
                      {formatDateTime(e.occurredAt)}
                    </Td>
                    <Td
                      className={cn("font-mono text-[12px] font-semibold", typeClass(e.eventType))}
                    >
                      <Link
                        to="/admin/events"
                        search={cleanSearch({ ...search, type: e.eventType, cursor: undefined })}
                        className="hover:underline"
                        title={`Only ${e.eventType}`}
                      >
                        {e.eventType}
                      </Link>
                    </Td>
                    <Td className="max-w-[200px]">
                      <Link
                        to="/admin/events"
                        search={cleanSearch({
                          ...search,
                          projectId: e.projectId,
                          cursor: undefined,
                        })}
                        className="block truncate hover:underline"
                        title={`Only ${e.projectName ?? e.projectId}`}
                      >
                        {e.projectName ?? e.projectId}
                      </Link>
                      {e.changeId && (
                        <Mono subtle truncate>
                          {e.changeId}
                        </Mono>
                      )}
                    </Td>
                    <Td className="max-w-[180px]">
                      {e.actorKind === "user" && e.actorId ? (
                        <Link
                          to="/admin/users/$userId"
                          params={{ userId: e.actorId }}
                          className="block truncate text-kumo-link hover:underline"
                          title={e.actorId}
                        >
                          {e.actorName ?? e.actorId}
                        </Link>
                      ) : (
                        <span className="block truncate" title={e.actorId ?? undefined}>
                          {e.actorName ?? e.actorId ?? EMPTY}
                        </span>
                      )}
                      <Mono subtle>{e.actorKind}</Mono>
                    </Td>
                    <Td className="max-w-[360px]">
                      <span className="line-clamp-2 break-words" title={e.summary ?? undefined}>
                        {e.summary || EMPTY}
                      </span>
                    </Td>
                  </TRow>
                ))
              ) : (
                <SkeletonRows cells={["numeric", 120, 140, 120, 100, 240]} />
              )}
            </tbody>
          </DataTable>
          {events.data && (
            <Pager
              shown={rows.length}
              noun={rows.length === 1 ? "event" : "events"}
              first={
                search.cursor
                  ? { to: "/admin/events", search: { ...search, cursor: undefined } }
                  : undefined
              }
              next={
                events.data.nextCursor
                  ? { to: "/admin/events", search: { ...search, cursor: events.data.nextCursor } }
                  : undefined
              }
            />
          )}
        </>
      )}
    </Section>
  );
}

function Filters({ search }: { search: EventFilters }) {
  const navigate = useNavigate({ from: "/admin/events" });
  const { draft, set } = useDraft({ ...search });
  const active = !!(search.userId || search.projectId || search.type || search.from || search.to);
  return (
    <FilterBar
      label="Filter events"
      active={active}
      onApply={() =>
        navigate({
          search: cleanSearch({
            userId: draft.userId?.trim(),
            projectId: draft.projectId?.trim(),
            type: eventTypeParam(draft.type),
            from: dateParam(draft.from),
            to: dateParam(draft.to),
          }),
        })
      }
      onClear={() => navigate({ search: {} })}
    >
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
      <TextFilter
        label="Type"
        placeholder="change.created"
        value={draft.type}
        onChange={(v) => set("type", v)}
      />
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
    </FilterBar>
  );
}
