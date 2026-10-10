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
import { Term } from "../components/ui/term";
import { getProductGraph, listChanges, type ProductGraph } from "../lib/api";
import { formatNumber, generation, generationCode, truncate } from "../lib/format";

/**
 * Product map (AGENTS.md 28, 38.3; internal name Product Graph). An Advanced page: the areas of
 * the Project and how they depend on each other. By default it shows only the areas one Change
 * touches; the scope switches between "This change" and "Whole product". The layout is static
 * and the map fits once per scope, with no edge animation.
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

const INTRO =
  "How the parts of the product depend on each other. The map shows only the areas one change touches unless you zoom out.";

function ProductGraphPage() {
  return (
    <Page>
      <Show when="signed-in">
        <GraphScreen />
      </Show>
      <Show when="signed-out">
        <PageTitle title="Product map" />
        <EmptyState
          what="Sign in to view the product map."
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
        : [{ label: "Whole product" }],
  });

  return (
    <>
      <PageTitle
        title={<Term k="productMap" />}
        meta={<span className="text-[14px]">{INTRO}</span>}
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
          </div>
        )}
      </div>

      {graph.isError && (
        <SectionError
          message={`The product map could not load. ${graph.error.message}`}
          onRetry={() => graph.refetch()}
          retrying={graph.isFetching}
        />
      )}

      <div className="grid gap-7 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
        <Section
          label={zoom === "change" ? "This change" : "Whole product"}
          meta={view && graph.data && <Summary view={view} graph={graph.data} />}
        >
          {graph.isPending || changes.isPending ? (
            <span
              aria-hidden
              className="skeleton block h-[clamp(340px,48vw,520px)] w-full rounded-lg"
            />
          ) : !view || view.areas.length === 0 ? (
            <EmptyState
              what="No product areas yet."
              how={
                graph.data?.fixture.applied || graph.data?.source?.kind === "index"
                  ? "Start a change; the areas its tasks touch show here."
                  : "Load the demo code from the Overview, or start a change."
              }
            />
          ) : (
            <ProductGraphCanvas view={view} selectedId={selected?.node.id} onSelect={onSelect} />
          )}
          {view && graph.data && view.areas.length > 0 && (
            <details className="rounded-lg border border-kumo-rule bg-kumo-elevated">
              <summary className="cursor-pointer px-4 py-2.5 text-[13px] font-semibold">
                Technical details
              </summary>
              <p className="max-w-[760px] px-4 pb-3 text-[12px] text-kumo-subtle">
                <Footnote graph={graph.data} view={view} zoom={zoom} />
              </p>
            </details>
          )}
        </Section>
        <Section label="Area details">
          <div className="rounded-lg border border-kumo-rule bg-kumo-elevated p-4">
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
  { value: "change", label: "This change", title: "Only the areas one change touches" },
  { value: "project", label: "Whole product", title: "Every area the listed changes touch" },
];

/** Scope switch (AGENTS.md 38.3 semantic zoom) as a two-button segmented control. */
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
        Show
      </span>
      <fieldset className="flex w-fit overflow-hidden rounded-md border border-kumo-rule">
        <legend className="sr-only">Show</legend>
        {ZOOMS.map(({ value, label, title }, index) => {
          const selected = zoom === value;
          const disabled = value === "change" && !changeAvailable;
          return (
            <button
              key={value}
              type="button"
              title={disabled ? "This project has no change yet" : title}
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onChange(value)}
              className={cn(
                "flex h-9 items-center px-3.5 text-[13px] transition-colors duration-150 focus-visible:outline-offset-[-2px] disabled:cursor-not-allowed disabled:opacity-45 pointer-coarse:h-11",
                index > 0 && "border-l border-kumo-rule",
                selected ? "bg-kumo-tint font-semibold" : "enabled:hover:bg-kumo-tint",
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

/** One sentence in place of the old stat strip. */
function Summary({ view, graph }: { view: GraphView; graph: ProductGraph }) {
  const count = (state: string) => view.areas.filter((a) => a.state === state).length;
  const conflicts = view.areas.reduce((n, a) => n + a.conflicts.length, 0);
  const parts = [
    `${formatNumber(view.areas.length)} of ${formatNumber(graph.nodes.length)} areas`,
    `${formatNumber(count("affected"))} changed`,
    `${formatNumber(count("new"))} new`,
    `${formatNumber(count("protected"))} must not change`,
  ];
  if (conflicts > 0) parts.push(`${formatNumber(conflicts)} conflict${conflicts > 1 ? "s" : ""}`);
  return (
    <span>
      {parts.join(" · ")}
      {graph.canonicalGeneration !== null && ` · ${generation(graph.canonicalGeneration)}`}
    </span>
  );
}

/** What the map is derived from and what it hides. Internal names are fine here. */
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
      Derived on each read from stored and live data: the semantic resources of{" "}
      {formatNumber(counts.tasks)} tasks and {formatNumber(counts.intents)} approaches (Intents)
      across {formatNumber(graph.changes.length)} changes, {formatNumber(counts.dependencies)} task
      dependencies, {formatNumber(counts.changeSets)} code changes (ChangeSets),{" "}
      {formatNumber(counts.conflicts)} conflicts, policy <Mono subtle>{graph.policyVersion}</Mono>{" "}
      protected resources ({graph.protectedResources.join(", ")})
      {graph.source?.kind === "index" ? (
        <>
          , and the imports of the indexed canonical tree{" "}
          <Mono subtle>{graph.source.treeSha.slice(0, 12)}</Mono>
          {graph.source.current ? "" : " (an earlier tree: the current one is not indexed yet)"}
        </>
      ) : graph.fixture.applied ? (
        <>
          , and the imports of <Mono subtle>{graph.fixture.source}</Mono> as seeded (not the current
          canonical tree)
        </>
      ) : (
        ", with no seeded source"
      )}
      .{" "}
      {graph.canonicalGeneration !== null && (
        <>
          Canonical generation <Mono subtle>{generationCode(graph.canonicalGeneration)}</Mono>.{" "}
        </>
      )}
      Edges point left to right, from an area to the area it depends on. Edge labels follow the area
      depended on: Identity is authorization, Catalog is product reference, Cart and Checkout are
      state. Hidden:{" "}
      {zoom === "change" && hidden.length > 0
        ? `${hidden.length} areas this change does not touch or border (${hidden.join(", ")}), `
        : ""}
      {view.hiddenEdges > 0 ? `${formatNumber(view.hiddenEdges)} edges to hidden areas, ` : ""}
      file and symbol dependencies, and runtime wiring ({graph.fixture.hiddenFiles.join(", ")}).
      {graph.truncated ? " Only the newest 20 changes and capped rows are read." : ""}
    </>
  );
}
