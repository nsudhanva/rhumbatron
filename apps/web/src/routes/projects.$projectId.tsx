import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Button, Input, InputArea } from "@cloudflare/kumo";
import { SignIn } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { EventStream } from "../components/project/event-stream";
import { SectionError, SkeletonBar, SkeletonRows } from "../components/project/feedback";
import {
  ACTIVE_CHANGE_STATUSES,
  ChangeStatusPill,
  TaskProgress,
} from "../components/project/status";
import { useEventFeed } from "../components/project/use-event-feed";
import { DataTable, RowLink, Td, Th, TitleCell, TRow } from "../components/ui/data-table";
import { EmptyState } from "../components/ui/empty-state";
import { KeyValue } from "../components/ui/key-value";
import { Mono } from "../components/ui/mono";
import { Page, PageTitle, Section, TwoUp } from "../components/ui/page";
import { StatCell, StatStrip } from "../components/ui/stat-strip";
import { Tag } from "../components/ui/tag";
import {
  type ChangeSummary,
  createChange,
  getProject,
  getProjectStats,
  listChanges,
  type ProjectStats as ProjectStatsData,
  provisionProject,
} from "../lib/api";
import { DEMO_GOAL, EMPTY, formatAge, formatNumber, formatUsd, generation } from "../lib/format";
import { useProjectLive } from "../lib/live";

export const Route = createFileRoute("/projects/$projectId")({ component: ProjectPage });

/** The changes endpoint returns the newest 20 (workers/api projects.ts). */
const CHANGE_LIMIT = 20;
/** Stats aggregate every Change of the Project: refetch at most this often on live pushes. */
const STATS_MIN_INTERVAL_MS = 10_000;
/** Safety net while the live socket is down. */
const FALLBACK_POLL_MS = 30_000;
const UNASSIGNED = "unassigned";

function ProjectPage() {
  return (
    <>
      <Show when="signed-in">
        <Overview />
      </Show>
      <Show when="signed-out">
        <Page>
          <PageTitle kicker="Project" title="Project" />
          <EmptyState
            what="Sign in to view this project."
            how="Projects are visible to members of their organization."
            action={
              <SignInButton>
                <Button variant="primary" icon={SignIn}>
                  Sign in
                </Button>
              </SignInButton>
            }
          />
        </Page>
      </Show>
    </>
  );
}

function Overview() {
  const { projectId } = Route.useParams();
  const [seeding, setSeeding] = useState(false);
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: projectId }),
    // Provisioning is asynchronous: poll until the canonical source is assigned.
    refetchInterval: (query) =>
      seeding && query.state.data?.canonical.artifactRef === UNASSIGNED ? 2000 : false,
  });
  const seed = useMutation({
    mutationFn: () => provisionProject({ data: { projectId, template: "acme-shop" } }),
    onSuccess: () => setSeeding(true),
  });
  const changes = useQuery({
    queryKey: ["changes", projectId],
    queryFn: () => listChanges({ data: projectId }),
    refetchInterval: (query) =>
      query.state.data?.some((c) => ["created", "compiling", "running"].includes(c.status))
        ? 2500
        : false,
  });

  const queryClient = useQueryClient();
  const stats = useQuery({
    queryKey: ["project-stats", projectId],
    queryFn: () => getProjectStats({ data: projectId }),
  });
  const feed = useEventFeed({ kind: "project", projectId }, { initial: 50 });
  // Live push (AGENTS.md section 39): each delta means new events were projected. The feed reads
  // only rows after its cursor; the stats aggregate refetches at most every 10 seconds.
  const statsAt = useRef(0);
  const socket = useProjectLive(projectId, true, () => {
    feed.refresh();
    void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    if (Date.now() - statsAt.current >= STATS_MIN_INTERVAL_MS) {
      statsAt.current = Date.now();
      void queryClient.invalidateQueries({ queryKey: ["project-stats", projectId] });
    }
  });
  const { refresh } = feed;
  useEffect(() => {
    if (socket === "open") return;
    const timer = setInterval(refresh, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [socket, refresh]);

  const source = project.data?.canonical;
  const assigned = !!source && source.artifactRef !== UNASSIGNED;
  const seedButton = (
    <Button variant="secondary" loading={seed.isPending || seeding} onClick={() => seed.mutate()}>
      Seed Acme Shop source
    </Button>
  );

  return (
    <Page>
      <PageTitle
        kicker="Project"
        title={
          project.data?.name ??
          (project.isPending ? (
            <SkeletonBar height={36} width={280} className="max-w-full" />
          ) : (
            "Project"
          ))
        }
        meta={
          project.data && (
            <>
              <Mono subtle>{project.data.slug}</Mono>
              <span aria-hidden>·</span>
              <Mono subtle>{generation(project.data.canonical.generation)}</Mono>
              <span aria-hidden>·</span>
              {assigned ? (
                <Mono subtle truncate className="max-w-[48ch]">
                  {source.artifactRef}
                </Mono>
              ) : (
                <span>No source yet</span>
              )}
            </>
          )
        }
      />

      {project.isError && (
        <SectionError
          message={`The project could not load. ${project.error.message}`}
          onRetry={() => project.refetch()}
          retrying={project.isFetching}
        />
      )}

      <ProjectStats
        generationValue={project.data ? generation(project.data.canonical.generation) : undefined}
        treeSha={assigned ? source.treeSha : undefined}
        changes={changes.data}
        stats={stats.data}
        statsFailed={stats.isError}
      />

      <Section
        label="Changes"
        meta={
          changes.isPending ? (
            <span role="status">Loading</span>
          ) : changes.data ? (
            <Mono subtle>
              {changes.data.length >= CHANGE_LIMIT
                ? `latest ${CHANGE_LIMIT}`
                : formatNumber(changes.data.length)}
            </Mono>
          ) : null
        }
      >
        {changes.isError ? (
          <SectionError
            message={`Changes could not load. ${changes.error.message}`}
            onRetry={() => changes.refetch()}
            retrying={changes.isFetching}
          />
        ) : changes.data?.length === 0 ? (
          <EmptyState
            what="No changes yet."
            how="Describe a goal under New change to start the first one."
          />
        ) : (
          <ChangesTable changes={changes.data} />
        )}
      </Section>

      <Section
        label="Recent events"
        meta={
          feed.events[0] ? <Mono subtle>latest #{formatNumber(feed.events[0].seq)}</Mono> : null
        }
      >
        <EventStream
          events={feed.events}
          loading={feed.loading}
          error={feed.error}
          onRetry={feed.refresh}
        />
      </Section>

      <TwoUp>
        <NewChange projectId={projectId} />
        <Section label="Canonical source">
          {project.isPending ? (
            <div className="grid gap-2">
              <SkeletonBar height={12} className="w-3/4" />
              <SkeletonBar height={12} className="w-1/2" />
              <SkeletonBar height={12} className="w-2/3" />
            </div>
          ) : project.data && assigned ? (
            <KeyValue
              items={[
                {
                  label: "Generation",
                  value: generation(project.data.canonical.generation),
                  mono: true,
                },
                { label: "Artifact", value: source.artifactRef, mono: true },
                { label: "Tree", value: source.treeSha, mono: true },
                { label: "Slug", value: project.data.slug, mono: true },
                { label: "Project ID", value: project.data.id, mono: true },
              ]}
            />
          ) : project.data ? (
            <>
              <EmptyState
                what="No canonical source yet."
                how={
                  seeding
                    ? "Seeding the Acme Shop codebase. This page updates when the source is assigned."
                    : "Seed the Acme Shop demo codebase so agents have code to change."
                }
                action={seedButton}
              />
              {seed.isError && (
                <SectionError message={`Seeding did not start. ${seed.error.message}`} />
              )}
            </>
          ) : (
            <p className="text-[13px] text-kumo-subtle">{EMPTY}</p>
          )}
        </Section>
      </TwoUp>
    </Page>
  );
}

/**
 * Stat strip: the canonical generation, the Change list (status and Task counts), and the stats
 * endpoint (Candidates and model calls across every Change). Cells without a source are left
 * out, not estimated.
 */
function ProjectStats({
  generationValue,
  treeSha,
  changes,
  stats,
  statsFailed,
}: {
  generationValue: string | undefined;
  treeSha: string | undefined;
  changes: ChangeSummary[] | undefined;
  stats: ProjectStatsData | undefined;
  statsFailed: boolean;
}) {
  const loading = <SkeletonBar height={34} width={96} />;
  const active = changes?.filter((c) => ACTIVE_CHANGE_STATUSES.has(c.status));
  const waiting = active?.filter((c) => c.status === "awaiting_approval").length ?? 0;
  const completed = changes?.filter((c) => c.status === "completed").length;
  const stopped = changes?.filter((c) => ["failed", "budget_blocked"].includes(c.status)).length;
  const tasks = changes?.reduce(
    (sum, c) => ({ done: sum.done + c.completedCount, total: sum.total + c.taskCount }),
    { done: 0, total: 0 },
  );
  const scope =
    changes && changes.length >= CHANGE_LIMIT ? `latest ${CHANGE_LIMIT} changes` : "all changes";
  return (
    <StatStrip>
      <StatCell
        label="Canonical generation"
        value={generationValue ?? loading}
        footnote={treeSha ? `tree ${treeSha.slice(0, 10)}` : EMPTY}
      />
      <StatCell
        label="Active changes"
        value={active ? formatNumber(active.length) : loading}
        footnote={
          changes
            ? waiting > 0
              ? `${formatNumber(waiting)} waiting on approval`
              : `${formatNumber(completed ?? 0)} completed${stopped ? ` · ${formatNumber(stopped)} failed or blocked` : ""}`
            : EMPTY
        }
      />
      <StatCell
        label="Tasks done"
        value={tasks ? formatNumber(tasks.done) : loading}
        unit={tasks ? `/ ${formatNumber(tasks.total)}` : undefined}
        footnote={changes ? scope : EMPTY}
      />
      {!statsFailed && (
        <StatCell
          label="Candidates verified"
          value={stats ? formatNumber(stats.candidates.verified) : loading}
          unit={stats ? `/ ${formatNumber(stats.candidates.total)}` : undefined}
          footnote={
            stats
              ? `${formatNumber(stats.candidates.promoted)} promoted · ${formatNumber(stats.candidates.rejected)} rejected`
              : EMPTY
          }
        />
      )}
      {!statsFailed && (
        <StatCell
          label="Model calls"
          value={stats ? formatNumber(stats.model.calls) : loading}
          footnote={
            stats
              ? `${formatUsd(stats.model.costUsd)} spent${stats.model.running > 0 ? ` · ${formatNumber(stats.model.running)} running` : ""}`
              : EMPTY
          }
        />
      )}
    </StatStrip>
  );
}

const RISK_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

function ChangesTable({ changes }: { changes: ChangeSummary[] | undefined }) {
  return (
    <DataTable label="Changes" minWidth={820}>
      <thead>
        <tr>
          <Th>Change</Th>
          <Th>Status</Th>
          <Th>Risk</Th>
          <Th numeric className="w-44">
            Tasks
          </Th>
          <Th numeric>Budget</Th>
          <Th numeric>Age</Th>
        </tr>
      </thead>
      <tbody aria-busy={!changes || undefined}>
        {!changes ? (
          <SkeletonRows cells={["title", 64, 48, "numeric", "numeric", "numeric"]} />
        ) : (
          changes.map((change) => (
            <TRow key={change.id}>
              <Td className="max-w-0 w-[50%]">
                <TitleCell
                  title={
                    <RowLink to="/changes/$changeId" params={{ changeId: change.id }}>
                      <span title={change.goal}>{change.goal}</span>
                    </RowLink>
                  }
                  meta={change.id}
                />
              </Td>
              <Td>
                <ChangeStatusPill status={change.status} />
              </Td>
              <Td>
                <RiskCell risk={change.riskTier} />
              </Td>
              <Td numeric>
                <TaskProgress done={change.completedCount} total={change.taskCount} />
              </Td>
              <Td numeric>{formatUsd(change.budgetUsd)}</Td>
              <Td numeric className="text-kumo-subtle">
                <time dateTime={change.createdAt} title={change.createdAt}>
                  {formatAge(change.createdAt)}
                </time>
              </Td>
            </TRow>
          ))
        )}
      </tbody>
    </DataTable>
  );
}

function RiskCell({ risk }: { risk: string | null }) {
  if (!risk) return <span className="text-kumo-subtle">{EMPTY}</span>;
  const label = RISK_LABEL[risk] ?? risk;
  return (
    <Tag variant={risk === "high" || risk === "critical" ? "outline" : "neutral"}>{label}</Tag>
  );
}

function NewChange({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [goal, setGoal] = useState(DEMO_GOAL);
  const [budget, setBudget] = useState("3");
  const budgetUsd = Number(budget);
  const create = useMutation({
    mutationFn: () => createChange({ data: { projectId, goal: goal.trim(), budgetUsd } }),
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: ["changes", projectId] });
      await navigate({ to: "/changes/$changeId", params: { changeId: id } });
    },
  });
  return (
    <Section label="New change">
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <InputArea
          label="Goal"
          description="The outcome in plain language. The planner derives acceptance criteria and protected invariants from it."
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={4}
          required
        />
        <div className="max-w-56">
          <Input
            label="Budget (USD)"
            description="New expensive work stops at this limit."
            type="number"
            min={0.1}
            step={0.1}
            className="font-mono"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            required
          />
        </div>
        {create.isError && (
          <SectionError message={`The change was not submitted. ${create.error.message}`} />
        )}
        <div>
          <Button
            type="submit"
            variant="primary"
            loading={create.isPending}
            disabled={!goal.trim() || !(budgetUsd > 0)}
          >
            Submit change
          </Button>
        </div>
      </form>
    </Section>
  );
}
