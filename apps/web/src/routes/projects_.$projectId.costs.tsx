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
import { getProjectCost } from "../lib/api";
import { formatClock, formatNumber, truncate } from "../lib/format";

/**
 * Costs (AGENTS.md sections 24, 44, 56). The default view is the selected Change's spend
 * against its budget and the spend of each Change. Usage by model tier and by Task, routing
 * outcomes from Decision Receipts, the free-tier meters and the list of what is not recorded sit
 * under "Details". Every figure is a recorded row; anything not recorded reads `—`.
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
        <PageTitle title="Costs" />
        <EmptyState
          what="Sign in to view costs."
          how="Spending and budgets are visible to members of the project's organization."
        />
      </Show>
    </Page>
  );
}

const INTRO = "What this project spent on AI models and compute. Only recorded usage is shown.";

function CostsView() {
  const { projectId } = Route.useParams();
  const { change: changeParam } = Route.useSearch();
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
        title="Costs"
        meta={
          <span className="text-[14px]">
            {INTRO}
            {data && (
              <span className="text-kumo-subtle">
                {" "}
                Updated <Mono subtle>{formatClock(data.generatedAt)}</Mono>.
              </span>
            )}
          </span>
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
          {selectedChange && (
            <Section label="This change">
              <BudgetHero change={selectedChange} />
            </Section>
          )}

          <Section
            label="Spend by change"
            meta={<span>{`newest ${formatNumber(data.changes.length)}`}</span>}
          >
            {data.changes.length === 0 ? (
              <EmptyState
                what="No changes yet."
                how="Spending appears here once a change starts its first task."
              />
            ) : (
              <ChangeTable projectId={projectId} changes={data.changes} selectedId={selectedId} />
            )}
          </Section>

          <details className="rounded-lg border border-kumo-rule bg-kumo-elevated">
            <summary className="cursor-pointer px-4 py-3 text-[14px] font-semibold">
              Details
              <span className="ml-2 font-normal text-kumo-subtle">
                Models, how they were chosen, and free-tier limits
              </span>
            </summary>
            <div className="grid gap-7 border-t border-kumo-rule px-4 pt-4 pb-5">
              {data.selected && (
                <>
                  <TwoUp>
                    <Section
                      label="Model usage"
                      meta={
                        <span title="Most calls one attempt may make, per model">{`per-attempt caps ${data.callCapPerRun.haiku} · ${data.callCapPerRun.sonnet} · ${data.callCapPerRun.opus}`}</span>
                      }
                    >
                      <TierTable byTier={data.selected.byTier} />
                    </Section>
                    <Section label="How models were chosen">
                      <RoutingOutcomes routing={data.selected.routing} />
                    </Section>
                  </TwoUp>

                  <Section
                    label="Model usage by task"
                    meta={<span>{formatNumber(data.selected.byTask.length)}</span>}
                  >
                    <TaskTable byTask={data.selected.byTask} />
                  </Section>
                </>
              )}
              <Section label="Free-tier limits">
                <UsageMeters meters={data.meters} changes={data.changes} />
              </Section>
              <NotRecorded vertexSpendLimitUsd={data.meters.vertexSpendLimitUsd} />
            </div>
          </details>
        </>
      )}
    </>
  );
}

function CostsSkeleton() {
  return (
    <div aria-busy className="grid gap-7">
      <Section label="This change">
        <div className="grid gap-2">
          <SkeletonBar height={15} className="w-1/2" />
          <SkeletonBar height={13} width={180} />
          <SkeletonBar height={4} className="w-full" />
        </div>
      </Section>
      <Section label="Spend by change">
        <DataTable label="Loading changes" minWidth={640}>
          <tbody>
            <SkeletonRows cells={["title", 64, "numeric", "numeric"]} />
          </tbody>
        </DataTable>
      </Section>
    </div>
  );
}
