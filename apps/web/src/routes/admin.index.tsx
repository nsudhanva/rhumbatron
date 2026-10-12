import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AdminPage } from "../components/admin/admin-page";
import { CapMeter } from "../components/costs-page/charts";
import { formatCost } from "../components/costs-page/cost-format";
import { SectionError, SkeletonBar } from "../components/project/feedback";
import { Section } from "../components/ui/page";
import { StatCell, StatStrip } from "../components/ui/stat-strip";
import { ADMIN_KEYS, getAdminOverview } from "../lib/api-admin";
import { monthName } from "../lib/api-budget";
import { formatDuration, formatNumber } from "../lib/format";
import { loadForAdmin, prefetch } from "../lib/ssr-data";

/**
 * Admin overview: the platform meters against their caps (model spend this month, Sandbox time,
 * Browser Run today, app builds today) and the counts of users, Projects, Changes and agents.
 * Every figure comes from the API's recorded meters (`usage_counters`).
 */
export const Route = createFileRoute("/admin/")({
  loader: ({ context: { queryClient } }) =>
    loadForAdmin(queryClient, () =>
      prefetch(queryClient, ADMIN_KEYS.overview, () => getAdminOverview()),
    ),
  component: OverviewPage,
});

function OverviewPage() {
  return (
    <AdminPage title="Overview" trail={[{ label: "Overview" }]}>
      <Overview />
    </AdminPage>
  );
}

const hours = (seconds: number) => seconds / 3600;
const formatHours = (h: number) => `${formatNumber(h, 1)} h`;
const formatSeconds = (s: number) => formatDuration(s);

function Overview() {
  const overview = useQuery({ queryKey: ADMIN_KEYS.overview, queryFn: () => getAdminOverview() });

  if (overview.isError) {
    return (
      <SectionError
        message={`The overview could not load. ${overview.error.message}`}
        onRetry={() => overview.refetch()}
        retrying={overview.isFetching}
      />
    );
  }
  const data = overview.data;
  if (!data) {
    return (
      <Section label="Meters">
        <div className="grid gap-2" role="status" aria-label="Loading the overview">
          <SkeletonBar height={15} className="w-1/2" />
          <SkeletonBar height={15} className="w-1/3" />
        </div>
      </Section>
    );
  }

  return (
    <>
      <Section label="Meters" meta={monthName(data.month)}>
        <StatStrip>
          <StatCell
            label="Model spend this month"
            value={formatCost(data.spendUsd)}
            unit={`/ ${formatCost(data.capUsd)}`}
            footnote="all users · stops at the cap"
          >
            <CapMeter
              label="monthly cap"
              value={data.spendUsd}
              cap={data.capUsd}
              format={formatCost}
            />
          </StatCell>
          <StatCell
            label="Sandbox this month"
            value={formatNumber(hours(data.sandbox.usedSeconds), 1)}
            unit={`h / ${formatNumber(hours(data.sandbox.capSeconds), 1)} h`}
            footnote={`${formatNumber(data.sandbox.usedSeconds)} s`}
          >
            <CapMeter
              label="monthly cap"
              value={hours(data.sandbox.usedSeconds)}
              cap={hours(data.sandbox.capSeconds)}
              format={formatHours}
            />
          </StatCell>
          <StatCell
            label="Browser Run today"
            value={formatSeconds(data.browser.usedSecondsToday)}
            unit={`/ ${formatSeconds(data.browser.capSecondsPerDay)}`}
            footnote="UTC day"
          >
            <CapMeter
              label="daily cap"
              value={data.browser.usedSecondsToday}
              cap={data.browser.capSecondsPerDay}
              format={formatSeconds}
            />
          </StatCell>
          <StatCell
            label="App builds today"
            value={formatNumber(data.appVersions.used)}
            unit={`/ ${formatNumber(data.appVersions.cap)}`}
            footnote="one new app version each · UTC day"
          >
            <CapMeter label="daily cap" value={data.appVersions.used} cap={data.appVersions.cap} />
          </StatCell>
        </StatStrip>
      </Section>

      <Section label="Counts">
        <StatStrip>
          <StatCell
            label="Users"
            value={formatNumber(data.users.total)}
            footnote={
              data.users.pending > 0 ? (
                <Link to="/admin/access" className="text-kumo-link hover:underline">
                  {formatNumber(data.users.pending)} waiting for approval
                </Link>
              ) : (
                "none waiting for approval"
              )
            }
          />
          <StatCell
            label="Projects"
            value={formatNumber(data.projects.active)}
            unit="active"
            footnote={`${formatNumber(data.projects.archived)} archived`}
          />
          <StatCell label="Active changes" value={formatNumber(data.changes.active)} />
          <StatCell label="Active agents" value={formatNumber(data.agents.active)} />
        </StatStrip>
      </Section>
    </>
  );
}
