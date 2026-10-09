import { Show } from "@clerk/tanstack-react-start";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BudgetHero } from "../components/costs-page/budget-hero";
import { ChangeTable, TaskTable, TierTable } from "../components/costs-page/cost-tables";
import { NotRecorded } from "../components/costs-page/not-recorded";
import { RoutingOutcomes } from "../components/costs-page/routing-outcomes";
import { UsageMeters } from "../components/costs-page/usage-meters";
import { SectionError, SkeletonBar, SkeletonRows } from "../components/project/feedback";
import { ACTIVE_CHANGE_STATUSES } from "../components/project/status";
import { usePageMeta } from "../components/shell/page-meta";
import { DataTable } from "../components/ui/data-table";
import { EmptyState } from "../components/ui/empty-state";
import { Mono } from "../components/ui/mono";
import { Page, PageTitle, Section, TwoUp } from "../components/ui/page";
import { getProject, getProjectCost } from "../lib/api";
import { formatClock, formatNumber, truncate } from "../lib/format";

/**
 * Costs (AGENTS.md sections 24, 44, 56): recorded model usage and spend per Change against its
 * budget, usage by tier and by Task, routing outcomes from Decision Receipts, and the free-tier
 * meters. Every figure is a recorded row; anything not recorded reads `—` and is named in the
 * footnote.
 */
export const Route = createFileRoute("/projects_/$projectId/costs")({
  validateSearch: (search: Record<string, unknown>): { change?: string } =>
    typeof search.change === "string" && /^chg_[a-z0-9-]+$/.test(search.change)
      ? { change: search.change }
      : {},
  component: CostsPage,
});

/** Poll while the selected Change still has work in flight. */
const POLL_MS = 10_000;

function CostsPage() {
  return (
    <Page>
      <Show when="signed-in">
        <CostsView />
      </Show>
      <Show when="signed-out">
        <PageTitle kicker="Costs" title="Costs" />
        <EmptyState
          what="Sign in to view costs."
          how="Model usage and budgets are visible to members of the Project's organization."
        />
      </Show>
    </Page>
  );
}

function CostsView() {
  const { projectId } = Route.useParams();
  const { change: changeParam } = Route.useSearch();
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: projectId }),
  });
  const cost = useQuery({
    queryKey: ["project-cost", projectId, changeParam ?? null],
    queryFn: () =>
      getProjectCost({ data: { projectId, ...(changeParam ? { changeId: changeParam } : {}) } }),
    refetchInterval: (query) => {
      const data = query.state.data;
      const selected = data?.changes.find((c) => c.id === data.selected?.changeId);
      return selected && ACTIVE_CHANGE_STATUSES.has(selected.status) ? POLL_MS : false;
    },
  });

  const data = cost.data;
  const selectedId = data?.selected?.changeId;
  const selectedChange = data?.changes.find((c) => c.id === selectedId);
  usePageMeta({
    trail: changeParam && selectedChange ? [{ label: truncate(selectedChange.goal, 48) }] : [],
  });

  return (
    <>
      <PageTitle
        kicker={project.data?.name ?? "Project"}
        title="Costs"
        meta={
          <>
            <span>Recorded usage only</span>
            {data && (
              <>
                <span>·</span>
                <span>
                  updated <Mono subtle>{formatClock(data.generatedAt)}</Mono>
                </span>
              </>
            )}
          </>
        }
      />

      {cost.isError ? (
        <SectionError
          message={`Costs could not load: ${cost.error.message}`}
          onRetry={() => cost.refetch()}
          retrying={cost.isFetching}
        />
      ) : !data ? (
        <CostsSkeleton />
      ) : (
        <>
          <UsageMeters meters={data.meters} changes={data.changes} />

          <Section
            label="Changes"
            meta={<Mono subtle>{`newest ${formatNumber(data.changes.length)}`}</Mono>}
          >
            {data.changes.length === 0 ? (
              <EmptyState
                what="No Changes yet."
                how="Spend appears here once a Change runs its first Task."
              />
            ) : (
              <ChangeTable projectId={projectId} changes={data.changes} selectedId={selectedId} />
            )}
          </Section>

          {selectedChange && data.selected && (
            <>
              <Section label="Change budget">
                <BudgetHero change={selectedChange} />
              </Section>

              <TwoUp>
                <Section
                  label="Model usage by tier"
                  meta={
                    <Mono
                      subtle
                    >{`per-run caps ${data.callCapPerRun.haiku} · ${data.callCapPerRun.sonnet} · ${data.callCapPerRun.opus}`}</Mono>
                  }
                >
                  <TierTable byTier={data.selected.byTier} />
                </Section>
                <Section label="Routing outcomes" meta="Decision Receipts">
                  <RoutingOutcomes routing={data.selected.routing} />
                </Section>
              </TwoUp>

              <Section
                label="Model usage by Task"
                meta={<Mono subtle>{formatNumber(data.selected.byTask.length)}</Mono>}
              >
                <TaskTable byTask={data.selected.byTask} />
              </Section>
            </>
          )}

          <NotRecorded vertexSpendLimitUsd={data.meters.vertexSpendLimitUsd} />
        </>
      )}
    </>
  );
}

function CostsSkeleton() {
  return (
    <div aria-busy className="grid gap-7">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-px border-y-2 border-kumo-divider bg-kumo-rule">
        {Array.from({ length: 4 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder cells have no identity
          <div key={i} className="grid gap-2 bg-kumo-base px-4 py-3">
            <SkeletonBar height={11} width={96} />
            <SkeletonBar height={34} width={72} />
            <SkeletonBar height={11} className="w-full" />
          </div>
        ))}
      </div>
      <Section label="Changes">
        <DataTable label="Loading Changes" minWidth={760}>
          <tbody>
            <SkeletonRows cells={["title", 64, "numeric", "numeric", "numeric", "numeric"]} />
          </tbody>
        </DataTable>
      </Section>
    </div>
  );
}
