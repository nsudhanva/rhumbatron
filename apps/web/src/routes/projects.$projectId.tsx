import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Button, Input, InputArea } from "@cloudflare/kumo";
import { SignIn } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { DeadLetters } from "../components/dead-letters";
import { EventStream } from "../components/project/event-stream";
import { SectionError, SkeletonBar, SkeletonRows } from "../components/project/feedback";
import { LiveAppLine } from "../components/project/live-app";
import { ProjectShare } from "../components/project/share-dialog";
import {
  ACTIVE_CHANGE_STATUSES,
  ChangeStatusPill,
  TaskProgress,
} from "../components/project/status";
import { useEventFeed } from "../components/project/use-event-feed";
import { DataTable, RowLink, Td, Th, TRow } from "../components/ui/data-table";
import { EmptyState } from "../components/ui/empty-state";
import { KeyValue } from "../components/ui/key-value";
import { Mono } from "../components/ui/mono";
import { Page, PageTitle, Section, TwoUp } from "../components/ui/page";
import { StatCell, StatStrip } from "../components/ui/stat-strip";
import { Tag } from "../components/ui/tag";
import {
  type ChangeRequester,
  type ChangeSummary,
  createChange,
  getGoalSuggestions,
  getProject,
  getProjectStats,
  listChanges,
  overrideChange,
  type ProjectStats as ProjectStatsData,
  provisionProject,
} from "../lib/api";
import { EMPTY, formatAge, formatNumber, formatUsd, generation } from "../lib/format";
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
    mutationFn: () => provisionProject({ data: projectId }),
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
    void queryClient.invalidateQueries({ queryKey: ["changes", projectId] });
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
      Create repository
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
              <LiveAppLine
                projectId={projectId}
                hasSource={assigned}
                canManage={project.data?.role !== "collaborator"}
              />
            </>
          )
        }
        actions={
          project.data?.role ? (
            <ProjectShare projectId={projectId} role={project.data.role} />
          ) : undefined
        }
      />

      <DeadLetters projectId={projectId} />

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
          <ChangesTable
            changes={changes.data}
            isOwner={project.data?.role === "owner"}
            projectId={projectId}
          />
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
                what="No repository yet."
                how={
                  seeding
                    ? "Creating the empty repository. This page updates when the source is assigned."
                    : "Create the empty repository so agents can build the app."
                }
                action={seedButton}
              />
              {seed.isError && (
                <SectionError message={`The repository was not created. ${seed.error.message}`} />
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

function ChangesTable({
  changes,
  isOwner,
  projectId,
}: {
  changes: ChangeSummary[] | undefined;
  isOwner?: boolean;
  projectId: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [overridingId, setOverridingId] = useState<string | null>(null);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  const override = useMutation({
    mutationFn: (changeId: string) => overrideChange({ data: changeId }),
    onMutate: (changeId) => {
      setOverridingId(changeId);
      setOverrideError(null);
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["changes", projectId] });
      if (result?.changeId) {
        await navigate({ to: "/changes/$changeId", params: { changeId: result.changeId } });
      }
    },
    onError: (err) => {
      setOverrideError(err.message);
    },
    onSettled: () => {
      setOverridingId(null);
    },
  });

  return (
    <div className="grid gap-2">
      {overrideError && <p className="text-[12px] text-kumo-danger font-medium">{overrideError}</p>}
      <DataTable label="Changes" minWidth={880}>
        <thead>
          <tr>
            <Th>Change</Th>
            <Th>Requested by</Th>
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
            <SkeletonRows cells={["title", 80, 64, 48, "numeric", "numeric", "numeric"]} />
          ) : (
            changes.map((change) => {
              const canOverride =
                isOwner && (change.status === "not_selected" || change.status === "awaiting_owner");
              return (
                <TRow key={change.id}>
                  <Td className="max-w-0 w-[45%]">
                    <div className="grid min-w-0 gap-0.5">
                      <div className="flex items-start justify-between gap-2">
                        <span className="truncate font-semibold">
                          <RowLink to="/changes/$changeId" params={{ changeId: change.id }}>
                            <span title={change.goal}>{change.goal}</span>
                          </RowLink>
                        </span>
                        {canOverride && (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="relative z-10 shrink-0 text-[11px] px-2 py-0.5 h-6 leading-tight whitespace-nowrap"
                            loading={override.isPending && overridingId === change.id}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              override.mutate(change.id);
                            }}
                          >
                            Use this instead
                          </Button>
                        )}
                      </div>
                      <ChangeOutcomeLine change={change} all={changes} />
                      <span className="truncate font-mono text-[11px] text-kumo-subtle tabular-nums">
                        {change.id}
                      </span>
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {change.requester ? (
                      <RequestedByCell requester={change.requester} />
                    ) : (
                      <span className="text-kumo-subtle">{EMPTY}</span>
                    )}
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
              );
            })
          )}
        </tbody>
      </DataTable>
    </div>
  );
}

function RequestedByCell({ requester }: { requester: ChangeRequester }) {
  const name = requester.isYou ? "You" : (requester.name ?? "Collaborator");
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px]">
      <span>{name}</span>
      {requester.rank === 0 && <Tag variant="outline">Owner</Tag>}
    </span>
  );
}

function ChangeOutcomeLine({ change, all }: { change: ChangeSummary; all: ChangeSummary[] }) {
  if (change.status === "awaiting_owner") {
    return (
      <span className="text-[12px] font-medium text-accent-700">
        Waiting for the owner to choose
      </span>
    );
  }
  const outcome = change.outcome;
  if (!outcome) return null;

  if (outcome.kind === "not_selected") {
    return (
      <span className="text-[12px] text-kumo-subtle inline-flex flex-wrap items-center gap-1">
        <span>Not selected{outcome.reason ? `: ${outcome.reason}` : ""}</span>
        {outcome.winnerChangeId && (
          <Link
            to="/changes/$changeId"
            params={{ changeId: outcome.winnerChangeId }}
            className="relative z-10 font-semibold text-kumo-link hover:underline"
          >
            (view winner)
          </Link>
        )}
      </span>
    );
  }
  if (outcome.kind === "selected") {
    return <span className="text-[12px] text-kumo-subtle">Selected</span>;
  }
  if (outcome.kind === "partially_selected") {
    return <span className="text-[12px] text-kumo-subtle">Partially selected</span>;
  }
  if (change.supersedesChangeId) {
    return (
      <span className="text-[12px] text-kumo-subtle inline-flex flex-wrap items-center gap-1">
        <span>Owner's choice, replaces an earlier request</span>
        <Link
          to="/changes/$changeId"
          params={{ changeId: change.supersedesChangeId }}
          className="relative z-10 font-semibold text-kumo-link hover:underline"
        >
          (view earlier)
        </Link>
      </span>
    );
  }
  if (outcome.kind === "replaces") {
    return <span className="text-[12px] text-kumo-subtle">Replaces earlier request</span>;
  }
  if (outcome.kind === "overridden") {
    const rebuilt = all.find((c) => c.supersedesChangeId === change.id);
    if (!rebuilt) return <span className="text-[12px] text-kumo-subtle">Chosen by the owner</span>;
    return (
      <span className="text-[12px] text-kumo-subtle inline-flex flex-wrap items-center gap-1">
        <span>Chosen by the owner: rebuilt as</span>
        <Link
          to="/changes/$changeId"
          params={{ changeId: rebuilt.id }}
          className="relative z-10 font-semibold text-kumo-link hover:underline"
        >
          the new Change
        </Link>
      </span>
    );
  }
  return <span className="text-[12px] text-kumo-subtle">{outcome.kind}</span>;
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
  const [goal, setGoal] = useState("");
  // Shares the Overview's project query; suggestions are cached per Canonical Generation.
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: projectId }),
  });
  const currentGeneration = project.data?.canonical.generation;
  const suggestions = useQuery({
    queryKey: ["goal-suggestions", projectId, currentGeneration],
    queryFn: () => getGoalSuggestions({ data: projectId }),
    enabled: currentGeneration !== undefined,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const pills = suggestions.data?.suggestions ?? [];
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
        {pills.length > 0 && (
          <ul className="-mt-2 flex flex-wrap gap-2" aria-label="Suggested goals">
            {pills.map((pill) => (
              <li key={pill}>
                <button
                  type="button"
                  className="bg-tone-100 px-2.5 py-[3px] text-[12px] leading-tight text-tone-800 hover:bg-tone-200"
                  onClick={() => setGoal(pill)}
                >
                  {pill}
                </button>
              </li>
            ))}
          </ul>
        )}
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
