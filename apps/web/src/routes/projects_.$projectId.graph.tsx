import { Show } from "@clerk/tanstack-react-start";
import { cn, Select } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useMemo } from "react";
import { AreaInspector } from "../components/product-graph/area-inspector";
import { buildView, type GraphView, type Zoom } from "../components/product-graph/model";
import { ProductGraphCanvas } from "../components/product-graph/product-graph-canvas";
import { SectionError, SkeletonBar } from "../components/project/feedback";
import { ACTIVE_CHANGE_STATUSES, ChangeStatusPill } from "../components/project/status";
import { usePageMeta } from "../components/shell/page-meta";
import { EmptyState } from "../components/ui/empty-state";
import { Mono } from "../components/ui/mono";
import { Page, PageTitle, Section } from "../components/ui/page";
import { StatCell, StatStrip } from "../components/ui/stat-strip";
import { getProductGraph, getProject, listChanges, type ProductGraph } from "../lib/api";
import { formatNumber, generation, truncate } from "../lib/format";

/**
 * Product Graph (AGENTS.md 28, 38.3; DESIGN.md 9.13). Semantic areas of the Project and how
 * they depend on each other. By default it shows only the subgraph one Change affects; the
 * zoom switches between Project and Change. Protected invariants always show.
 */

type Search = { zoom?: Zoom; changeId?: string; area?: string };

export const Route = createFileRoute("/projects_/$projectId/graph")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    ...(search.zoom === "project" || search.zoom === "change" ? { zoom: search.zoom } : {}),
    ...(typeof search.changeId === "string" && /^chg_[a-z0-9-]+$/.test(search.changeId)
      ? { changeId: search.changeId }
      : {}),
    ...(typeof search.area === "string" && /^[a-z][a-z0-9-]*$/.test(search.area)
      ? { area: search.area }
      : {}),
  }),
  component: ProductGraphPage,
});

/** Re-derive while a Change in scope is still working; idle graphs do not poll (D1 reads). */
const POLL_MS = 15_000;

function ProductGraphPage() {
  return (
    <Page>
      <Show when="signed-in">
        <GraphScreen />
      </Show>
      <Show when="signed-out">
        <PageTitle kicker="Project" title="Product Graph" />
        <EmptyState
          what="Sign in to view the Product Graph."
          how="Projects are visible to members of their organization."
        />
      </Show>
    </Page>
  );
}

function GraphScreen() {
  const { projectId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: projectId }),
  });
  const changes = useQuery({
    queryKey: ["changes", projectId],
    queryFn: () => listChanges({ data: projectId }),
  });

  const changeList = changes.data ?? [];
  // Newest Change by default (listChanges is newest first).
  const changeId =
    search.changeId && changeList.some((c) => c.id === search.changeId)
      ? search.changeId
      : changeList[0]?.id;
  const zoom: Zoom = changeId ? (search.zoom ?? "change") : "project";
  const selectedChange = changeList.find((c) => c.id === changeId);
  const working =
    zoom === "change"
      ? !!selectedChange && ACTIVE_CHANGE_STATUSES.has(selectedChange.status)
      : changeList.some((c) => ACTIVE_CHANGE_STATUSES.has(c.status));

  const graph = useQuery({
    queryKey: ["product-graph", projectId],
    queryFn: () => getProductGraph({ data: projectId }),
    refetchInterval: working ? POLL_MS : false,
  });

  const view = useMemo(
    () => (graph.data ? buildView(graph.data, zoom, changeId) : undefined),
    [graph.data, zoom, changeId],
  );
  const selected =
    view?.areas.find((a) => a.node.id === search.area) ??
    view?.areas.find((a) => a.state === "new") ??
    view?.areas.find((a) => a.touched);

  const setSearch = useCallback(
    (patch: Search) => {
      void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
    },
    [navigate],
  );
  const onSelect = useCallback((area: string) => setSearch({ area }), [setSearch]);

  usePageMeta({
    trail:
      zoom === "change" && selectedChange
        ? [{ label: truncate(selectedChange.goal, 44) }]
        : [{ label: "All Changes" }],
  });

  return (
    <>
      <PageTitle
        kicker={project.data?.name ?? "Project"}
        title="Product Graph"
        meta={
          <>
            {graph.data?.canonicalGeneration !== null &&
              graph.data?.canonicalGeneration !== undefined && (
                <>
                  <Mono subtle>{generation(graph.data.canonicalGeneration)}</Mono>
                  <span aria-hidden>·</span>
                </>
              )}
            <span>
              {zoom === "change"
                ? "Areas one Change affects, protected invariants, and their direct dependencies"
                : "Every area the listed Changes touch, plus the seeded source"}
            </span>
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <ZoomControl
          zoom={zoom}
          changeAvailable={!!changeId}
          onChange={(next) => setSearch({ zoom: next })}
        />
        {changeList.length > 0 && (
          <div className="grid gap-1.5">
            <span className="text-[12px] text-kumo-subtle" id="graph-change-label">
              Change
            </span>
            <Select
              aria-labelledby="graph-change-label"
              className="w-[min(480px,calc(100vw-32px))]"
              value={changeId ?? null}
              disabled={zoom !== "change"}
              onValueChange={(value) => {
                if (typeof value === "string") setSearch({ changeId: value, zoom: "change" });
              }}
              items={Object.fromEntries(changeList.map((c) => [c.id, truncate(c.goal, 72)]))}
            />
          </div>
        )}
        {zoom === "change" && selectedChange && (
          <div className="flex items-center gap-2 pb-1.5">
            <ChangeStatusPill status={selectedChange.status} />
            <Mono subtle>{selectedChange.id}</Mono>
          </div>
        )}
      </div>

      {graph.isError && (
        <SectionError
          message={`The Product Graph could not load. ${graph.error.message}`}
          onRetry={() => graph.refetch()}
          retrying={graph.isFetching}
        />
      )}

      {view && graph.data && <GraphStats view={view} graph={graph.data} />}

      <div className="grid gap-7 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
        <Section
          label={zoom === "change" ? "Affected subgraph" : "Project graph"}
          meta={
            view && (
              <Mono subtle>
                {formatNumber(view.areas.length)} areas · {formatNumber(view.edges.length)} edges
              </Mono>
            )
          }
        >
          {graph.isPending || changes.isPending ? (
            <span aria-hidden className="skeleton block h-[clamp(340px,48vw,520px)] w-full" />
          ) : !view || view.areas.length === 0 ? (
            <EmptyState
              what="No product areas yet."
              how={
                graph.data?.fixture.applied
                  ? "Submit a Change; its Tasks declare the semantic resources this graph shows."
                  : "Seed the Acme Shop source on the project overview, or submit a Change."
              }
            />
          ) : (
            <ProductGraphCanvas
              view={view}
              selectedId={selected?.node.id}
              onSelect={onSelect}
              caption={graph.data && <Footnote graph={graph.data} view={view} zoom={zoom} />}
            />
          )}
        </Section>
        <Section label="Area details">
          <div
            className={cn(
              "bg-kumo-elevated p-4",
              // The accent bar pairs the inspector with the selected node; none when empty.
              selected && "shadow-[inset_2px_0_0_var(--color-accent-500)]",
            )}
          >
            {view && graph.data ? (
              <AreaInspector area={selected} view={view} graph={graph.data} zoom={zoom} />
            ) : (
              <span className="grid gap-2">
                <SkeletonBar height={20} className="w-[60%]" />
                <SkeletonBar height={13} className="w-[90%]" />
                <SkeletonBar height={13} className="w-[75%]" />
              </span>
            )}
          </div>
        </Section>
      </div>
    </>
  );
}

const ZOOMS: { value: Zoom; label: string; title: string }[] = [
  { value: "project", label: "Project", title: "Every area the listed Changes touch" },
  { value: "change", label: "Change", title: "Only the areas one Change affects" },
];

/** Semantic zoom (AGENTS.md 38.3): segmented control, selected in ink (DESIGN.md 8.2). */
function ZoomControl({
  zoom,
  changeAvailable,
  onChange,
}: {
  zoom: Zoom;
  changeAvailable: boolean;
  onChange: (zoom: Zoom) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-[12px] text-kumo-subtle" aria-hidden>
        Zoom
      </span>
      <fieldset className="flex w-fit border border-kumo-divider">
        <legend className="sr-only">Zoom</legend>
        {ZOOMS.map(({ value, label, title }, index) => {
          const selected = zoom === value;
          const disabled = value === "change" && !changeAvailable;
          return (
            <button
              key={value}
              type="button"
              title={disabled ? "This Project has no Change yet" : title}
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onChange(value)}
              className={cn(
                "flex h-9 items-center px-3.5 text-[13px] transition-colors duration-(--rh-dur-ui) focus-visible:outline-offset-[-2px] disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11",
                index > 0 && "border-l border-kumo-divider",
                selected ? "bg-kumo-ink text-kumo-inverse" : "enabled:hover:bg-kumo-tint",
              )}
            >
              {label}
            </button>
          );
        })}
      </fieldset>
    </div>
  );
}

function GraphStats({ view, graph }: { view: GraphView; graph: ProductGraph }) {
  const touched = view.areas.filter((a) => a.touched).length;
  const fresh = view.areas.filter((a) => a.state === "new").length;
  const guarded = view.areas.filter((a) => a.state === "protected");
  const conflicts = view.areas.reduce((n, a) => n + a.conflicts.length, 0);
  return (
    <StatStrip>
      <StatCell
        label="Areas shown"
        value={formatNumber(view.areas.length)}
        footnote={`of ${formatNumber(graph.nodes.length)} · ${formatNumber(view.hiddenAreas.length)} hidden`}
      />
      <StatCell
        label="Touched"
        value={formatNumber(touched)}
        footnote={`${formatNumber(fresh)} new`}
      />
      <StatCell
        label="Protected"
        value={formatNumber(guarded.length)}
        footnote={graph.protectedResources.join(" · ")}
      />
      <StatCell label="Conflicts" value={formatNumber(conflicts)} footnote="on visible areas" />
    </StatStrip>
  );
}

/** What the graph is derived from and what it hides (DESIGN.md 9.13). */
function Footnote({
  graph,
  view,
  zoom,
}: {
  graph: ProductGraph;
  view: GraphView;
  zoom: Zoom;
}): ReactNode {
  const { counts } = graph;
  const hidden = view.hiddenAreas.map((n) => n.name);
  return (
    <>
      Derived on each read, not stored: semantic resources of {formatNumber(counts.tasks)} Tasks and{" "}
      {formatNumber(counts.intents)} Intents across {formatNumber(graph.changes.length)} Changes,{" "}
      {formatNumber(counts.dependencies)} Task dependencies, {formatNumber(counts.changeSets)}{" "}
      ChangeSets, {formatNumber(counts.conflicts)} conflicts, policy{" "}
      <Mono subtle>{graph.policyVersion}</Mono> protected resources (
      {graph.protectedResources.join(", ")})
      {graph.fixture.applied ? (
        <>
          , and the imports of <Mono subtle>{graph.fixture.source}</Mono> as seeded (not the current
          canonical tree)
        </>
      ) : (
        ", with no seeded source"
      )}
      . Edge labels follow the area depended on: Identity is authorization, Catalog is product
      reference, Cart and Checkout are state. Hidden:{" "}
      {zoom === "change" && hidden.length > 0
        ? `${hidden.length} areas this Change does not touch or border (${hidden.join(", ")}), `
        : ""}
      {view.hiddenEdges > 0 ? `${formatNumber(view.hiddenEdges)} edges to hidden areas, ` : ""}
      file and symbol dependencies, and runtime wiring ({graph.fixture.hiddenFiles.join(", ")}).
      {graph.truncated ? " Only the newest 20 Changes and capped rows are read." : ""} Select an
      area to inspect it.
    </>
  );
}
