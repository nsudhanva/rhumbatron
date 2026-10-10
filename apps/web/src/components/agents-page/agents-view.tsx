import { cn } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getProject, getProjectAgents, type ProjectAgents } from "../../lib/api";
import { formatNumber, formatUsd, timeAgo } from "../../lib/format";
import { SectionError, SkeletonBar, SkeletonRows } from "../project/feedback";
import { DataTable, Th } from "../ui/data-table";
import { EmptyState } from "../ui/empty-state";
import { Mono } from "../ui/mono";
import { Page, PageTitle, Section } from "../ui/page";
import { StatCell, StatStrip } from "../ui/stat-strip";
import { StatusPill } from "../ui/status-pill";
import { AgentInspector } from "./agent-inspector";
import { AgentTable } from "./agent-table";
import { SleepingPool } from "./sleeping-pool";

/** Poll while an agent is active. Idle pages do not poll, to stay inside the D1 read allowance. */
const ACTIVE_POLL_MS = 15_000;

/**
 * Agents page body (AGENTS.md 38.6, 57): active and recently active agents one by one, the rest
 * of the pool aggregated by role. Selecting a row fills the inspector beside the tables.
 */
export function AgentsView({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: projectId }),
  });
  const agents = useQuery({
    queryKey: ["project-agents", projectId],
    queryFn: () => getProjectAgents({ data: projectId }),
    refetchInterval: (query) =>
      (query.state.data?.totals.active ?? 0) > 0 ? ACTIVE_POLL_MS : false,
  });
  const [selected, setSelected] = useState<string | null>(null);

  const data = agents.data;
  const list = data?.agents ?? [];
  const active = list.filter((a) => a.state === "active");
  const recent = list.filter((a) => a.state === "sleeping");
  const current = list.find((a) => a.agentId === selected) ?? active[0] ?? recent[0];
  const stale = agents.isError && !!data;

  return (
    <Page>
      <PageTitle
        kicker={project.data?.name ?? "Project"}
        title="Agents"
        meta={
          <>
            <span>One agent per Task</span>
            <span aria-hidden>·</span>
            <span>active and recently active agents listed, sleeping agents grouped by role</span>
          </>
        }
      />

      {agents.isError && (
        <SectionError
          message={
            stale
              ? `Agents could not refresh. Showing data from ${timeAgo(new Date(agents.dataUpdatedAt).toISOString())}. ${agents.error.message}`
              : `Agents could not load. ${agents.error.message}`
          }
          onRetry={() => agents.refetch()}
          retrying={agents.isFetching}
        />
      )}

      <AgentStats data={data} pending={agents.isPending} />

      {agents.isPending ? (
        <Section label="Active">
          <DataTable minWidth={760} label="Loading agents">
            <thead>
              <tr>
                <Th>Agent</Th>
                <Th>Task</Th>
                <Th>Model</Th>
                <Th numeric>Calls this run</Th>
                <Th numeric>Cost</Th>
                <Th numeric>Updated</Th>
                <Th>State</Th>
              </tr>
            </thead>
            <tbody>
              <SkeletonRows cells={["title", "title", 48, "numeric", "numeric", "numeric", 56]} />
            </tbody>
          </DataTable>
        </Section>
      ) : data && list.length === 0 && data.totals.agents === 0 ? (
        <Section label="Agents">
          <EmptyState
            what="No agent has woken in this Project yet."
            how="Submit a Change on the Overview. Each Task's agent wakes when the Task becomes ready."
          />
        </Section>
      ) : data ? (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(320px,400px)] items-start gap-7 max-[1100px]:grid-cols-1">
          <div className="grid min-w-0 gap-7">
            <Section
              label="Active"
              meta={
                <>
                  {stale && <StatusPill status="stale" />}
                  <Mono subtle>{active.length}</Mono>
                </>
              }
            >
              {active.length === 0 ? (
                <EmptyState
                  what="No agent is working right now."
                  how="Agents sleep when their run ends and wake when a Task becomes ready."
                />
              ) : (
                <AgentTable
                  agents={active}
                  variant="active"
                  selectedId={current?.agentId ?? null}
                  onSelect={setSelected}
                  label="Active agents"
                />
              )}
            </Section>

            <Section
              label="Recently active"
              meta={
                <>
                  <span>last {data.recentHours} h · asleep</span>
                  <Mono subtle>{recent.length}</Mono>
                </>
              }
            >
              {recent.length === 0 ? (
                <EmptyState what={`No agent slept in the last ${data.recentHours} h.`} />
              ) : (
                <AgentTable
                  agents={recent}
                  variant="recent"
                  selectedId={current?.agentId ?? null}
                  onSelect={setSelected}
                  label="Recently active agents"
                />
              )}
            </Section>

            <Section
              label="Sleeping pool"
              meta={
                <>
                  <span>not listed</span>
                  <Mono subtle>
                    {formatNumber(data.sleeping.unlisted.reduce((s, r) => s + r.count, 0))}
                  </Mono>
                </>
              }
            >
              <SleepingPool unlisted={data.sleeping.unlisted} notWoken={data.notWoken} />
            </Section>
          </div>

          {current ? (
            <AgentInspector agent={current} feedAvailable={data.feed.available} />
          ) : (
            <aside className="bg-kumo-elevated p-4">
              <EmptyState what="No agent selected." how="Select an agent to see its detail." />
            </aside>
          )}
        </div>
      ) : null}
    </Page>
  );
}
AgentsView.displayName = "AgentsView";

/** Active, sleeping, escalations, and today's model calls against the daily cap. */
function AgentStats({ data, pending }: { data: ProjectAgents | undefined; pending: boolean }) {
  const loading = <SkeletonBar height={34} width={64} />;
  const value = (n: number | undefined) => (pending || n === undefined ? loading : formatNumber(n));
  const today = data?.today;
  const capReached = !!today && today.accountCalls >= today.cap;
  return (
    <StatStrip>
      <StatCell
        label="Active"
        value={value(data?.totals.active)}
        footnote={data ? `of ${formatNumber(data.totals.agents)} woken` : undefined}
      />
      <StatCell
        label="Sleeping"
        value={value(data?.sleeping.total)}
        footnote={data ? `${formatNumber(data.notWoken)} not woken` : undefined}
      />
      <StatCell
        label="Escalations"
        value={value(data?.totals.escalations)}
        footnote={
          data
            ? `${formatNumber(data.totals.runs)} runs · ${formatUsd(data.totals.costUsd)}`
            : undefined
        }
      />
      <StatCell
        label="Model calls today"
        value={value(today?.accountCalls)}
        unit={today ? `/ ${formatNumber(today.cap)}` : undefined}
        pill={capReached ? <StatusPill status="blocked" label="Cap reached" /> : undefined}
        footnote={
          today
            ? `account-wide daily cap · this project ${formatNumber(today.projectCalls)}`
            : undefined
        }
      >
        {today && <CapBar used={today.accountCalls} cap={today.cap} />}
      </StatCell>
    </StatStrip>
  );
}
AgentStats.displayName = "AgentStats";

/**
 * Daily cap as a 4px linear bar (DESIGN.md 9.1): ink fill on a recessed track, `danger` once the
 * cap is reached, because reaching it stops new agent work. The value is in the cell above.
 */
function CapBar({ used, cap }: { used: number; cap: number }) {
  const reached = used >= cap;
  return (
    <div aria-hidden className="h-1 bg-kumo-recessed">
      <div
        className={cn(
          "h-full transition-[width] duration-(--rh-dur-bar)",
          reached ? "bg-kumo-danger" : "bg-kumo-ink",
        )}
        style={{ width: `${Math.min(100, (used / Math.max(1, cap)) * 100)}%` }}
      />
    </div>
  );
}
CapBar.displayName = "CapBar";
