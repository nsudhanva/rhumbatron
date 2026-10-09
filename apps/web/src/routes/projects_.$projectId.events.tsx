import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Button, buttonVariants, cn } from "@cloudflare/kumo";
import { SignIn, X } from "@phosphor-icons/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";
import { EventPlane } from "../components/events-page/event-plane";
import { EventStream } from "../components/events-page/event-stream";
import { type FeedEvent, typeTone } from "../components/events-page/feed-model";
import { type FetchFeedPage, useEventFeed } from "../components/events-page/use-event-feed";
import { SectionError } from "../components/project/feedback";
import { usePageMeta } from "../components/shell/page-meta";
import { EmptyState } from "../components/ui/empty-state";
import { Mono } from "../components/ui/mono";
import { Page, PageTitle, Section } from "../components/ui/page";
import { StatCell, StatStrip } from "../components/ui/stat-strip";
import { listChangeEvents, listProjectEvents } from "../lib/api";
import { EMPTY, formatAge, formatClock, formatNumber } from "../lib/format";
import { type LiveStatus, useProjectLive } from "../lib/live";
import { SystemsOnly, useViewMode } from "../lib/view-mode";

/**
 * Project events (AGENTS.md 16.1, 17, 38, 39; DESIGN.md 9.9): the causal facts of one Project,
 * newest first, live. The rows come from the feed projection; the live socket only says that
 * something changed, and each signal pulls the events after the newest sequence shown.
 * `?change=<id>` narrows the stream to one Change.
 */
type EventsSearch = { change?: string };

export const Route = createFileRoute("/projects_/$projectId/events")({
  validateSearch: (search: Record<string, unknown>): EventsSearch =>
    typeof search.change === "string" && search.change ? { change: search.change } : {},
  component: EventsPage,
});

/** Fallback pulls, for events that change no ProjectView list (renewed Claims, model routes). */
const POLL_OPEN_MS = 30_000;
const POLL_CLOSED_MS = 15_000;

function EventsPage() {
  return (
    <>
      <Show when="signed-in">
        <EventsView />
      </Show>
      <Show when="signed-out">
        <Page>
          <PageTitle kicker="Project" title="Events" />
          <EmptyState
            what="Sign in to view this Project's events."
            how="Events are visible to members of the Project's organization."
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

function EventsView() {
  const { projectId } = Route.useParams();
  const { change: changeId } = Route.useSearch();
  usePageMeta({ trail: changeId ? [{ label: changeId, mono: true }] : [] });
  const systems = useViewMode() === "systems";

  const fetchPage = useCallback<FetchFeedPage>(
    (cursor) =>
      changeId
        ? listChangeEvents({ data: { changeId, ...cursor } })
        : listProjectEvents({ data: { projectId, ...cursor } }),
    [projectId, changeId],
  );
  const feed = useEventFeed(`${projectId}:${changeId ?? ""}`, fetchPage);
  const { pull } = feed;

  const live = useProjectLive(projectId, true, () => pull());

  // Fallback pull: slower while the socket is open, faster while it is down. Visible tabs only.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") pull();
    };
    const timer = setInterval(tick, live === "open" ? POLL_OPEN_MS : POLL_CLOSED_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [live, pull]);

  const loading = feed.status === "loading";

  return (
    <Page>
      <PageTitle
        kicker={changeId ? "Change events" : "Project events"}
        title="Events"
        meta={
          <>
            <span>Causal facts, newest first</span>
            <span aria-hidden>·</span>
            <LiveWord status={live} />
            {changeId && (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-2">
                  <span>Change</span>
                  <Link
                    to="/changes/$changeId"
                    params={{ changeId }}
                    className="font-mono text-[12px] text-kumo-accent underline-offset-2 hover:underline"
                  >
                    {changeId}
                  </Link>
                </span>
              </>
            )}
          </>
        }
        actions={
          changeId && (
            <Link
              to="/projects/$projectId/events"
              params={{ projectId }}
              search={{}}
              className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "gap-1.5")}
            >
              <X size={14} aria-hidden />
              All project events
            </Link>
          )
        }
      />

      {feed.status === "error" && (
        <SectionError
          message={`Events could not load. ${feed.error ?? ""}`}
          onRetry={() => void feed.retry()}
        />
      )}

      <EventStats events={feed.events} loading={loading} />

      <SystemsOnly>
        <EventPlane projectId={projectId} events={feed.events} live={live} />
      </SystemsOnly>

      <Section
        label="Stream"
        meta={
          feed.pullError ? (
            <span className="text-kumo-warning" role="status">
              Live update failed. Retrying.
            </span>
          ) : (
            <Mono subtle>{loading ? "loading" : `${formatNumber(feed.events.length)} loaded`}</Mono>
          )
        }
      >
        <EventStream
          projectId={projectId}
          events={feed.events}
          loading={loading}
          systems={systems}
          scopedToChange={!!changeId}
          footer={
            feed.status === "ready" && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {feed.hasOlder ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={feed.loadingOlder}
                    onClick={() => void feed.loadOlder()}
                  >
                    Load older
                  </Button>
                ) : (
                  feed.events.length > 0 && (
                    <span className="text-[12px] text-kumo-subtle">
                      Start of the recorded stream. Older events are in the R2 audit archive.
                    </span>
                  )
                )}
                {feed.olderError && (
                  <span className="text-[12px] text-kumo-danger" role="alert">
                    Older events could not load. {feed.olderError}
                  </span>
                )}
                {feed.events.length > 0 && (
                  <Mono subtle>
                    {`seq ${formatNumber(feed.events.at(-1)?.seq)} – ${formatNumber(feed.events[0]?.seq)}`}
                  </Mono>
                )}
              </div>
            )
          }
        />
      </Section>
    </Page>
  );
}

/** Connection word for the title meta. The status bar carries the square dot. */
function LiveWord({ status }: { status: LiveStatus }) {
  const text = status === "open" ? "Live" : status === "connecting" ? "Connecting" : "Polling";
  return <span className={status === "open" ? "text-kumo-success" : undefined}>{text}</span>;
}

function EventStats({ events, loading }: { events: FeedEvent[]; loading: boolean }) {
  const summary = useMemo(() => {
    let failures = 0;
    let commits = 0;
    for (const event of events) {
      const tone = typeTone(event);
      if (tone === "danger") failures += 1;
      else if (tone === "brand") commits += 1;
    }
    return { failures, commits, latest: events[0] };
  }, [events]);
  const show = (value: string) => (loading ? EMPTY : value);
  return (
    <StatStrip>
      <StatCell
        label="Latest sequence"
        value={show(summary.latest ? String(summary.latest.seq) : EMPTY)}
        mono
        footnote={summary.latest ? summary.latest.eventType : "no events yet"}
      />
      <StatCell
        label="Last event"
        value={show(summary.latest ? formatAge(summary.latest.occurredAt) : EMPTY)}
        footnote={summary.latest ? formatClock(summary.latest.occurredAt) : EMPTY}
      />
      <StatCell
        label="Failures"
        value={show(formatNumber(summary.failures))}
        footnote="failed, rejected, expired or stale"
      />
      <StatCell
        label="Canonical commits"
        value={show(formatNumber(summary.commits))}
        footnote={`in ${formatNumber(events.length)} loaded events`}
      />
    </StatStrip>
  );
}
