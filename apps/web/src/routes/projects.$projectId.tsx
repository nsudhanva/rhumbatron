import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Button, buttonVariants, cn, Input, InputArea } from "@cloudflare/kumo";
import { HandPalm, type Icon, PauseCircle, SignIn, WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { DeadLetters, deadLettersQuery } from "../components/dead-letters";
import { NOTIFICATION_KEYS } from "../components/notifications/notification-keys";
import { SectionError, SkeletonBar } from "../components/project/feedback";
import {
  ACTIVE_CHANGE_STATUSES,
  ChangeStatusPill,
  TaskProgress,
} from "../components/project/status";
import { useEventFeed } from "../components/project/use-event-feed";
import { EmptyState } from "../components/ui/empty-state";
import { Page, PageTitle, Section } from "../components/ui/page";
import { Term } from "../components/ui/term";
import {
  type AppNotification,
  type ChangeSummary,
  createChange,
  type FeedEvent,
  getProject,
  getProjectCost,
  listChanges,
  listNotifications,
  type NotificationKind,
  type ProjectCost,
  provisionProject,
} from "../lib/api";
import { DEMO_GOAL, formatUsd, generation, timeAgo, truncate } from "../lib/format";
import { useProjectLive } from "../lib/live";

export const Route = createFileRoute("/projects/$projectId")({ component: ProjectPage });

/** Safety net while the live socket is down. */
const FALLBACK_POLL_MS = 30_000;
const UNASSIGNED = "unassigned";
/** Recent changes shown before "Show all" (the API returns the newest 20). */
const RECENT_SHOWN = 10;
const RELEASES_SHOWN = 5;

function ProjectPage() {
  return (
    <>
      <Show when="signed-in">
        <Overview />
      </Show>
      <Show when="signed-out">
        <Page>
          <PageTitle title="Project" />
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

/** Release number of a `canonical.advanced` event, read defensively from its kept fields. */
function releaseOf(event: FeedEvent): number | undefined {
  const value = event.data.toGeneration ?? event.data.generation;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  const match = /S(\d+)\s*$/.exec(event.summary);
  return match ? Number(match[1]) : undefined;
}

/**
 * Project overview (research 7.3): the live release, the composer for a new change, what needs
 * a person, changes in progress, recent changes, and on the side the releases and the spend.
 */
function Overview() {
  const { projectId } = Route.useParams();
  const queryClient = useQueryClient();
  const [seeding, setSeeding] = useState(false);
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: projectId }),
    // Provisioning is asynchronous: poll until the code is assigned.
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

  const feed = useEventFeed({ kind: "project", projectId }, { initial: 50 });
  // Live push (AGENTS.md section 39): each delta means new events were recorded.
  const socket = useProjectLive(projectId, true, () => {
    feed.refresh();
    void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
  });
  const { refresh } = feed;
  useEffect(() => {
    if (socket === "open") return;
    const timer = setInterval(refresh, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [socket, refresh]);

  const releases = feed.events.filter((e) => e.eventType === "canonical.advanced");
  const latest = releases[0];
  const source = project.data?.canonical;
  const hasCode = !!source && source.artifactRef !== UNASSIGNED;
  const goals = new Map(changes.data?.map((c) => [c.id, c.goal]));

  return (
    <Page>
      <PageTitle
        title={
          project.data?.name ??
          (project.isPending ? (
            <SkeletonBar height={32} width={280} className="max-w-full" />
          ) : (
            "Project"
          ))
        }
        meta={
          project.data &&
          (hasCode ? (
            <span>
              Live: <Term k="release">{generation(project.data.canonical.generation)}</Term>
              {latest && (
                <>
                  {" · shipped "}
                  <time dateTime={latest.occurredAt} title={latest.occurredAt}>
                    {timeAgo(latest.occurredAt)}
                  </time>
                </>
              )}
            </span>
          ) : (
            <span>No code yet</span>
          ))
        }
      />

      {project.isError && (
        <SectionError
          message={`The project could not load. ${project.error.message}`}
          onRetry={() => project.refetch()}
          retrying={project.isFetching}
        />
      )}

      {project.data && !hasCode && (
        <div className="grid justify-items-start gap-3 rounded-lg border border-kumo-rule bg-kumo-elevated p-4">
          <p className="text-[14px]">
            {seeding
              ? "Loading the Acme Shop demo code. This page updates when it is ready."
              : "This project has no code yet. Load the demo code to start."}
          </p>
          <Button
            variant="secondary"
            loading={seed.isPending || seeding}
            onClick={() => seed.mutate()}
          >
            Load the Acme Shop demo code
          </Button>
          {seed.isError && (
            <SectionError message={`Loading did not start. ${seed.error.message}`} />
          )}
        </div>
      )}

      <div className="grid gap-7 min-[1100px]:grid-cols-[minmax(0,1fr)_320px] min-[1100px]:items-start">
        <div className="grid min-w-0 content-start gap-7">
          <NewChange projectId={projectId} />
          <NeedsYou projectId={projectId} />
          <Changes changes={changes.data} error={changes.error} onRetry={() => changes.refetch()} />
        </div>
        <aside aria-label="Releases and spend" className="grid min-w-0 content-start gap-4">
          <Releases events={releases} goals={goals} loading={feed.loading} />
          <Spend projectId={projectId} />
        </aside>
      </div>
    </Page>
  );
}

function NewChange({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [goal, setGoal] = useState("");
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
    <section
      aria-label="New change"
      className="rounded-lg border border-kumo-rule bg-kumo-elevated p-4"
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <div className="grid gap-1.5">
          <InputArea
            label="What should change?"
            placeholder={DEMO_GOAL}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={4}
            required
          />
          {!goal && (
            <button
              type="button"
              onClick={() => setGoal(DEMO_GOAL)}
              className="w-fit text-[13px] text-kumo-link hover:underline"
            >
              Use this example
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="w-40">
            <Input
              label="Budget (USD)"
              type="number"
              min={0.1}
              step={0.1}
              className="font-mono"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              required
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            loading={create.isPending}
            disabled={!goal.trim() || !(budgetUsd > 0)}
          >
            Start change
          </Button>
        </div>
        <p className="text-[12px] text-kumo-subtle">
          Budget {formatUsd(budgetUsd > 0 ? budgetUsd : 0)} per change. New work stops at this
          limit.
        </p>
        {create.isError && (
          <SectionError message={`The change did not start. ${create.error.message}`} />
        )}
      </form>
    </section>
  );
}

/** Dead letters and paused work have their own rows (with Retry / Dismiss) in DeadLetters. */
const COVERED_BY_DEAD_LETTERS = new Set<NotificationKind>(["dead_letter", "budget_blocked"]);

const ACTION_ICON: Partial<Record<NotificationKind, Icon>> = {
  approval_required: HandPalm,
  budget_blocked: PauseCircle,
};

/** Open action items for this project (research 7.3 "Needs you"). Hidden when empty. */
function NeedsYou({ projectId }: { projectId: string }) {
  const inbox = useQuery({
    queryKey: NOTIFICATION_KEYS.list,
    queryFn: () => listNotifications(),
    staleTime: 30_000,
    retry: 1,
  });
  // Same cache entry DeadLetters reads: no second request.
  const stuck = useQuery(deadLettersQuery(projectId));
  const actions = (inbox.data?.items ?? []).filter(
    (item) =>
      item.projectId === projectId &&
      item.severity === "action" &&
      !COVERED_BY_DEAD_LETTERS.has(item.kind),
  );
  const stuckCount = (stuck.data?.deadLetters.length ?? 0) + (stuck.data?.limits.length ?? 0);
  if (actions.length === 0 && stuckCount === 0) return null;
  return (
    <Section label="Needs you">
      {actions.length > 0 && (
        <ul className="grid overflow-hidden rounded-lg border border-kumo-rule bg-kumo-elevated">
          {actions.map((item) => (
            <ActionRow key={item.id} item={item} />
          ))}
        </ul>
      )}
      <DeadLetters projectId={projectId} />
    </Section>
  );
}

function ActionRow({ item }: { item: AppNotification }) {
  const IconComponent = ACTION_ICON[item.kind] ?? WarningCircle;
  // `href` is an app path from the API; the router resolves it at runtime.
  const to = item.href as "/";
  return (
    <li className="flex items-center gap-3 border-b border-kumo-rule px-3 py-2.5 last:border-b-0">
      <IconComponent size={16} aria-hidden className="shrink-0 text-kumo-warning" />
      <span className="grid min-w-0 flex-1">
        <span className="truncate text-[14px] font-medium" title={item.title}>
          {item.title}
        </span>
        {item.body && <span className="truncate text-[12px] text-kumo-subtle">{item.body}</span>}
      </span>
      <Link
        to={to}
        aria-label={`Open: ${item.title}`}
        className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "shrink-0")}
      >
        Open
      </Link>
    </li>
  );
}

function Changes({
  changes,
  error,
  onRetry,
}: {
  changes: ChangeSummary[] | undefined;
  error: Error | null;
  onRetry: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  if (error) {
    return <SectionError message={`Changes could not load. ${error.message}`} onRetry={onRetry} />;
  }
  if (!changes) {
    return (
      <div className="grid gap-3" aria-hidden>
        <SkeletonBar height={88} className="rounded-lg" />
        <SkeletonBar height={44} className="rounded-lg" />
      </div>
    );
  }
  if (changes.length === 0) {
    return (
      <EmptyState
        what="No changes yet."
        how="Describe what should change above to start the first one."
      />
    );
  }
  const active = changes.filter((c) => ACTIVE_CHANGE_STATUSES.has(c.status));
  const recent = changes.filter((c) => !ACTIVE_CHANGE_STATUSES.has(c.status));
  const shown = showAll ? recent : recent.slice(0, RECENT_SHOWN);
  return (
    <>
      {active.length > 0 && (
        <Section label="In progress">
          <ul className="grid gap-3 min-[720px]:grid-cols-2">
            {active.map((change) => (
              <li key={change.id} className="min-w-0">
                <Link
                  to="/changes/$changeId"
                  params={{ changeId: change.id }}
                  className="grid h-full gap-3 rounded-lg border border-kumo-rule bg-kumo-elevated p-4 transition-colors duration-(--rh-dur-ui) hover:border-kumo-line focus-visible:outline-offset-2"
                >
                  <span className="line-clamp-2 text-[15px] font-medium" title={change.goal}>
                    {change.goal}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-kumo-subtle">
                    <ChangeStatusPill status={change.status} />
                    <span>
                      Started{" "}
                      <time dateTime={change.createdAt} title={change.createdAt}>
                        {timeAgo(change.createdAt)}
                      </time>
                    </span>
                  </span>
                  <TaskProgress done={change.completedCount} total={change.taskCount} />
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {recent.length > 0 && (
        <Section label="Recent changes">
          <ul className="grid overflow-hidden rounded-lg border border-kumo-rule bg-kumo-elevated">
            {shown.map((change) => (
              <li key={change.id} className="border-b border-kumo-rule last:border-b-0">
                <Link
                  to="/changes/$changeId"
                  params={{ changeId: change.id }}
                  className="flex items-center gap-3 px-3 py-2.5 transition-colors duration-(--rh-dur-ui) hover:bg-kumo-tint focus-visible:outline-offset-[-2px]"
                >
                  <ChangeStatusPill status={change.status} />
                  <span className="min-w-0 flex-1 truncate text-[14px]" title={change.goal}>
                    {change.goal}
                  </span>
                  <time
                    dateTime={change.createdAt}
                    title={change.createdAt}
                    className="shrink-0 text-[12px] text-kumo-subtle"
                  >
                    {timeAgo(change.createdAt)}
                  </time>
                </Link>
              </li>
            ))}
          </ul>
          {recent.length > RECENT_SHOWN && !showAll && (
            <div>
              <Button size="sm" variant="secondary" onClick={() => setShowAll(true)}>
                Show all ({recent.length})
              </Button>
            </div>
          )}
        </Section>
      )}
    </>
  );
}

function SideCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      className="grid gap-3 rounded-lg border border-kumo-rule bg-kumo-elevated p-4"
    >
      <h2 className="text-[14px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Releases({
  events,
  goals,
  loading,
}: {
  events: FeedEvent[];
  goals: Map<string, string>;
  loading: boolean;
}) {
  return (
    <SideCard title="Releases">
      {loading && events.length === 0 ? (
        <SkeletonBar height={12} className="w-2/3" />
      ) : events.length === 0 ? (
        <p className="text-[13px] text-kumo-subtle">Nothing shipped yet.</p>
      ) : (
        <ol className="grid gap-3">
          {events.slice(0, RELEASES_SHOWN).map((event) => {
            const release = releaseOf(event);
            const goal = event.changeId ? goals.get(event.changeId) : undefined;
            return (
              <li key={event.seq} className="grid gap-0.5">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-[14px] font-medium">
                    {release !== undefined ? generation(release) : "New release"}
                  </span>
                  <time
                    dateTime={event.occurredAt}
                    title={event.occurredAt}
                    className="shrink-0 text-[12px] text-kumo-subtle"
                  >
                    {timeAgo(event.occurredAt)}
                  </time>
                </span>
                {goal && (
                  <span className="text-[12px] text-kumo-subtle" title={goal}>
                    {truncate(goal, 80)}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </SideCard>
  );
}

/** Recorded model spend on the changes started this month (the cost API's month, UTC). */
function monthSpend(cost: ProjectCost) {
  const month = cost.meters.month;
  return cost.changes
    .filter((c) => c.createdAt.slice(0, 7) === month)
    .reduce((sum, c) => sum + c.costUsd, 0);
}

function Spend({ projectId }: { projectId: string }) {
  // Same key as the Costs page with no change selected, so the two share the read.
  const cost = useQuery({
    queryKey: ["project-cost", projectId, null],
    queryFn: () => getProjectCost({ data: { projectId } }),
  });
  if (cost.isError) return null;
  return (
    <SideCard title="Spend this month">
      {cost.data ? (
        <>
          <p className="text-[20px] font-semibold tabular-nums">
            {formatUsd(monthSpend(cost.data))}
          </p>
          <Link
            to="/projects/$projectId/costs"
            params={{ projectId }}
            className="w-fit text-[13px] text-kumo-link hover:underline"
          >
            See costs
          </Link>
        </>
      ) : (
        <SkeletonBar height={24} width={96} />
      )}
    </SideCard>
  );
}
