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
import { ProjectRemove } from "../components/project/remove-dialog";
import { ProjectShare } from "../components/project/share-dialog";
import {
  ACTIVE_CHANGE_STATUSES,
  ChangeStatusPill,
  TaskProgress,
} from "../components/project/status";
import { useEventFeed } from "../components/project/use-event-feed";
import { ProjectTimeline } from "../components/timeline/project-timeline";
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
  type ProjectStats as ProjectStatsData,
  provisionProject,
} from "../lib/api";
import { getProjectSettings } from "../lib/api-settings";
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
  // Each live signal also refreshes the execution timeline (it reads only what changed).
  const [pulse, setPulse] = useState(0);
  const socket = useProjectLive(projectId, true, () => {
    setPulse((n) => n + 1);
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
            <>
              <ProjectShare projectId={projectId} role={project.data.role} />
              <ProjectRemove
                projectId={projectId}
                projectName={project.data.name}
                role={project.data.role}
              />
            </>
          ) : undefined
        }
      />

      <div id="operator-actions" className="scroll-mt-6 empty:hidden">
        <DeadLetters projectId={projectId} />
      </div>

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

      <ProjectTimeline
        projectId={projectId}
        changes={changes.data}
        changesError={changes.isError}
        pulse={pulse}
        socketOpen={socket === "open"}
      />

      <Section
        id="changes"
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
  const loading = <SkeletonBar height={18} width={56} />;
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
    <StatStrip density="compact">
      <StatCell
        label="Generation"
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
          label="Verified"
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
  return (
    <div className="grid gap-2">
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
      {requester.rank === 0 && <Tag variant="neutral">Owner</Tag>}
    </span>
  );
}

function ChangeOutcomeLine({ change, all }: { change: ChangeSummary; all: ChangeSummary[] }) {
  if (change.status === "needs_input") {
    return (
      <span className="text-[12px] font-medium text-accent-700">
        Waiting for an answer from the requester
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
  if (outcome.kind === "replaces") {
    return <span className="text-[12px] text-kumo-subtle">Replaces earlier request</span>;
  }
  if (outcome.kind === "duplicate") {
    return (
      <span className="text-[12px] text-kumo-subtle">
        Duplicate{outcome.reason ? `: ${outcome.reason}` : ""}
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

/** `budget: null` until the user types one: the field then shows the Project's default budget. */
type ChangeDraft = { goal: string; budget: string | null };
/** Used only until the Project settings load (the API applies the same built-in default). */
const FALLBACK_BUDGET = "3";
/** Unsent drafts live outside the component so a remount (auth refresh, route re-render) keeps them. */
const drafts = new Map<string, ChangeDraft>();

function readDraft(projectId: string): ChangeDraft {
  const held = drafts.get(projectId);
  if (held) return held;
  try {
    const raw = sessionStorage.getItem(`rhumbatron:draft:${projectId}`);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ChangeDraft>;
      return {
        goal: typeof parsed.goal === "string" ? parsed.goal : "",
        budget: typeof parsed.budget === "string" ? parsed.budget : null,
      };
    }
  } catch {
    // Storage unavailable or corrupt: start from an empty draft.
  }
  return { goal: "", budget: null };
}

function writeDraft(projectId: string, draft: ChangeDraft | null) {
  const key = `rhumbatron:draft:${projectId}`;
  if (draft) drafts.set(projectId, draft);
  else drafts.delete(projectId);
  try {
    if (draft) sessionStorage.setItem(key, JSON.stringify(draft));
    else sessionStorage.removeItem(key);
  } catch {
    // Best effort only.
  }
}

function NewChange({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => readDraft(projectId));
  const [invalid, setInvalid] = useState<string | null>(null);
  const settings = useQuery({
    queryKey: ["project-settings", projectId],
    queryFn: () => getProjectSettings({ data: projectId }),
    staleTime: 60_000,
  });
  const defaultBudget =
    settings.data !== undefined ? String(settings.data.effectiveDefaultBudgetUsd) : FALLBACK_BUDGET;
  const goal = draft.goal;
  const budget = draft.budget ?? defaultBudget;
  const update = (patch: Partial<ChangeDraft>) => {
    const next = { ...readDraft(projectId), ...patch };
    writeDraft(projectId, next);
    setDraft(next);
    setInvalid(null);
  };
  const setGoal = (value: string) => update({ goal: value });
  const setBudget = (value: string) => update({ budget: value });
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
  const budgetUsd = Number(budget);
  const create = useMutation({
    mutationFn: () => createChange({ data: { projectId, goal: goal.trim(), budgetUsd } }),
    onSuccess: async ({ id }) => {
      writeDraft(projectId, null);
      setDraft({ goal: "", budget: null });
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
          if (!goal.trim()) setInvalid("Describe the goal before you submit.");
          else if (!(budgetUsd > 0)) setInvalid("Set a budget above $0.00.");
          else create.mutate();
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
            description={
              draft.budget === null && settings.data
                ? "The Project's default. New expensive work stops at this limit."
                : "New expensive work stops at this limit."
            }
            type="number"
            min={0.1}
            step={0.1}
            className="font-mono"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            required
          />
        </div>
        {invalid && (
          <p role="alert" className="text-[12px] font-semibold text-kumo-danger">
            {invalid}
          </p>
        )}
        {create.isError && (
          <SectionError message={`The change was not submitted. ${create.error.message}`} />
        )}
        <div>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Submit change
          </Button>
        </div>
      </form>
    </Section>
  );
}
