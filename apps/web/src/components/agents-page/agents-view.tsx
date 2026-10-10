import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getProject, getProjectAgents, type ProjectAgents } from "../../lib/api";
import { formatNumber, formatUsd, timeAgo } from "../../lib/format";
import { SectionError, SkeletonRows } from "../project/feedback";
import { DataTable, Th } from "../ui/data-table";
import { EmptyState } from "../ui/empty-state";
import { KeyValue } from "../ui/key-value";
import { Page, PageTitle, Section } from "../ui/page";
import { StatusPill } from "../ui/status-pill";
import { Term } from "../ui/term";
import { AgentInspector } from "./agent-inspector";
import { AgentTable } from "./agent-table";
import { Details } from "./agent-words";
import { SleepingPool } from "./sleeping-pool";

/** Poll while an agent is active. Idle pages do not poll, to stay inside the D1 read allowance. */
const ACTIVE_POLL_MS = 15_000;

/**
 * Agents page body (Advanced; AGENTS.md 38.6, 57): working and recently active agents one by
 * one, idle agents as one sentence. Selecting a row fills the inspector beside the tables. A
 * one-line summary replaces the stat strip; account usage sits under "Technical details".
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
  const capReached = !!data && data.today.accountCalls >= data.today.cap;

  return (
    <Page>
      <PageTitle
        title={<Term k="agent">Agents</Term>}
        meta={
          <>
            {project.data?.name && <span>{project.data.name}</span>}
            {data && <span>{summary(data)}</span>}
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

      {capReached && data && (
        <p className="flex flex-wrap items-center gap-2 text-[14px]">
          <StatusPill status="paused" label="Daily limit reached" />
          <span>
            Agents used all {formatNumber(data.today.cap)} model calls allowed today. New agent work
            waits until tomorrow.
          </span>
        </p>
      )}

      {agents.isPending ? (
        <Section label="Working now">
          <DataTable minWidth={680} label="Loading agents">
            <thead>
              <tr>
                <Th>Agent</Th>
                <Th>Task</Th>
                <Th>Model</Th>
                <Th numeric>Cost</Th>
                <Th numeric>Updated</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              <SkeletonRows cells={["title", "title", "title", "numeric", "numeric", 56]} />
            </tbody>
          </DataTable>
        </Section>
      ) : data && list.length === 0 && data.totals.agents === 0 ? (
        <Section label="Agents">
          <EmptyState
            what="No agent has started in this project yet."
            how="Start a change on the Overview. Each task's agent starts when the task is ready."
          />
        </Section>
      ) : data ? (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(320px,400px)] items-start gap-7 max-[1100px]:grid-cols-1">
          <div className="grid min-w-0 gap-7">
            <Section
              label="Working now"
              meta={
                <>
                  {stale && <StatusPill status="stale" label="Not refreshed" />}
                  <span className="tabular-nums">{formatNumber(active.length)}</span>
                </>
              }
            >
              {active.length === 0 ? (
                <EmptyState
                  what="No agent is working right now."
                  how="An agent starts when its task is ready and goes idle when it finishes."
                />
              ) : (
                <AgentTable
                  agents={active}
                  variant="active"
                  selectedId={current?.agentId ?? null}
                  onSelect={setSelected}
                  label="Agents working now"
                />
              )}
            </Section>

            <Section
              label="Recently active"
              meta={
                <>
                  <span>last {data.recentHours} h</span>
                  <span className="tabular-nums">{formatNumber(recent.length)}</span>
                </>
              }
            >
              {recent.length === 0 ? (
                <EmptyState what={`No agent finished in the last ${data.recentHours} h.`} />
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

            <Section label="Idle">
              <SleepingPool
                total={data.sleeping.total}
                unlisted={data.sleeping.unlisted}
                notWoken={data.notWoken}
              />
            </Section>

            <Details>
              <Usage data={data} />
            </Details>
          </div>

          {current ? (
            <AgentInspector agent={current} feedAvailable={data.feed.available} />
          ) : (
            <aside className="rounded-lg border border-kumo-rule bg-kumo-elevated p-4">
              <EmptyState what="No agent selected." how="Select an agent to see its detail." />
            </aside>
          )}
        </div>
      ) : null}
    </Page>
  );
}
AgentsView.displayName = "AgentsView";

/** "3 working · 2 done in the last 24 h · 12 idle": the one-line summary under the title. */
function summary(data: ProjectAgents): string {
  const done = data.agents.filter(
    (a) => a.state === "sleeping" && a.task.status === "completed",
  ).length;
  return [
    `${formatNumber(data.totals.active)} working`,
    `${formatNumber(done)} done in the last ${data.recentHours} h`,
    `${formatNumber(data.sleeping.total)} idle`,
  ].join(" · ");
}

/** Totals and the account-wide daily call cap, in the Advanced vocabulary. */
function Usage({ data }: { data: ProjectAgents }) {
  const { totals, today } = data;
  return (
    <KeyValue
      items={[
        { label: "Agents started", value: formatNumber(totals.agents), mono: true },
        { label: "Not started yet", value: formatNumber(data.notWoken), mono: true },
        { label: "Attempts (runs)", value: formatNumber(totals.runs), mono: true },
        {
          label: "Retried with a stronger model (escalations)",
          value: formatNumber(totals.escalations),
          mono: true,
        },
        { label: "Model calls", value: formatNumber(totals.modelCalls), mono: true },
        { label: "Cost", value: formatUsd(totals.costUsd), mono: true },
        {
          label: `Model calls today (${today.day})`,
          value: `${formatNumber(today.accountCalls)} of ${formatNumber(today.cap)} account-wide · this project ${formatNumber(today.projectCalls)}`,
          mono: true,
        },
      ]}
    />
  );
}
Usage.displayName = "Usage";
