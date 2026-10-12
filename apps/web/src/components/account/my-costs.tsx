import type { MyCosts as MyCostsData } from "@rhumbatron/protocol";
import { useQuery } from "@tanstack/react-query";
import { getMyCosts, MY_COSTS_KEY, MY_COSTS_MONTHS } from "../../lib/api-admin";
import { monthName } from "../../lib/api-budget";
import { formatNumber } from "../../lib/format";
import { BarList } from "../costs-page/charts";
import { formatCost } from "../costs-page/cost-format";
import { SectionError, SkeletonBar } from "../project/feedback";
import { DataTable, RowLink, Td, Th, TitleCell, TRow } from "../ui/data-table";
import { EmptyState } from "../ui/empty-state";
import { Section, TwoUp } from "../ui/page";

/**
 * The signed-in user's own model spend (`GET /v1/me/costs`): the last six months, this month by
 * Project, and this month by request. Each Project and request links to its page.
 */
export function MyCosts() {
  const costs = useQuery({
    queryKey: MY_COSTS_KEY,
    queryFn: () => getMyCosts({ data: MY_COSTS_MONTHS }),
  });

  if (costs.isError) {
    return (
      <Section label="My spend">
        <SectionError
          message={`Your spend could not load. ${costs.error.message}`}
          onRetry={() => costs.refetch()}
          retrying={costs.isFetching}
        />
      </Section>
    );
  }
  const data = costs.data;
  if (!data) {
    return (
      <Section label="My spend">
        <div className="grid gap-2" role="status" aria-label="Loading your spend">
          <SkeletonBar height={13} className="w-1/2" />
          <SkeletonBar height={13} className="w-1/3" />
        </div>
      </Section>
    );
  }
  return <MyCostsView data={data} />;
}
MyCosts.displayName = "MyCosts";

function MyCostsView({ data }: { data: MyCostsData }) {
  // Oldest first, whatever order the API sends.
  const months = [...data.months].sort((a, b) => a.month.localeCompare(b.month));
  const thisMonth = months.at(-1);
  return (
    <>
      <TwoUp>
        <Section label={`Spend, last ${MY_COSTS_MONTHS} months`}>
          {months.every((m) => m.spendUsd === 0) ? (
            <EmptyState
              what="No recorded spend in these months."
              how="Spend appears when the agents work on your requests."
            />
          ) : (
            <BarList
              className="max-w-[640px]"
              items={months.map((m) => ({
                label: monthName(m.month),
                value: m.spendUsd,
                text: formatCost(m.spendUsd),
              }))}
            />
          )}
        </Section>

        <Section
          label="This month by Project"
          meta={thisMonth ? monthName(thisMonth.month) : undefined}
        >
          {data.byProject.length === 0 ? (
            <EmptyState
              what="No spend this month."
              how="Requests you make in any Project count here."
            />
          ) : (
            <DataTable label="My spend this month by Project" minWidth={360}>
              <thead>
                <tr>
                  <Th>Project</Th>
                  <Th numeric>Spend</Th>
                </tr>
              </thead>
              <tbody>
                {data.byProject.map((p) => (
                  <TRow key={p.projectId}>
                    <Td className="max-w-[320px]">
                      <TitleCell
                        title={
                          <RowLink
                            to="/projects/$projectId/costs"
                            params={{ projectId: p.projectId }}
                          >
                            {p.name}
                          </RowLink>
                        }
                      />
                    </Td>
                    <Td numeric>{formatCost(p.spendUsd)}</Td>
                  </TRow>
                ))}
              </tbody>
            </DataTable>
          )}
        </Section>
      </TwoUp>

      <Section
        label="This month by request"
        meta={data.byChange.length > 0 ? `top ${formatNumber(data.byChange.length)}` : undefined}
      >
        {data.byChange.length === 0 ? (
          <EmptyState
            what="No requests with spend this month."
            how="Each request you make shows here with what its model work cost."
          />
        ) : (
          <DataTable label="My spend this month by request" minWidth={560}>
            <thead>
              <tr>
                <Th>Request</Th>
                <Th>Project</Th>
                <Th numeric>Spend</Th>
              </tr>
            </thead>
            <tbody>
              {data.byChange.map((c) => (
                <TRow key={c.changeId}>
                  <Td className="max-w-[420px]">
                    <TitleCell
                      title={
                        <RowLink to="/changes/$changeId" params={{ changeId: c.changeId }}>
                          {c.title || c.changeId}
                        </RowLink>
                      }
                      meta={c.changeId}
                    />
                  </Td>
                  <Td className="max-w-[220px] truncate">{c.projectName}</Td>
                  <Td numeric>{formatCost(c.spendUsd)}</Td>
                </TRow>
              ))}
            </tbody>
          </DataTable>
        )}
      </Section>

      <p className="max-w-[760px] border-t border-kumo-rule pt-3 text-[11px] text-kumo-subtle">
        <span className="font-semibold">Source:</span> {data.source}
      </p>
    </>
  );
}
