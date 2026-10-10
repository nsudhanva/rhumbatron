import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Button, buttonVariants, cn } from "@cloudflare/kumo";
import { SignIn, X } from "@phosphor-icons/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { EventPlane } from "../components/events-page/event-plane";
import { EventStream } from "../components/events-page/event-stream";
import type { FeedEvent } from "../components/events-page/feed-model";
import { type FetchFeedPage, useEventFeed } from "../components/events-page/use-event-feed";
import { SectionError } from "../components/project/feedback";
import { usePageMeta } from "../components/shell/page-meta";
import { EmptyState } from "../components/ui/empty-state";
import { Mono } from "../components/ui/mono";
import { Page, PageTitle, Section } from "../components/ui/page";
import { Term } from "../components/ui/term";
import { listChangeEvents, listProjectEvents } from "../lib/api";
import { formatAge, formatNumber } from "../lib/format";
import { type LiveStatus, useProjectLive } from "../lib/live";
import { SystemsOnly, useViewMode } from "../lib/view-mode";

/**
 * Event log (Advanced; AGENTS.md 16.1, 17, 38, 39): the raw causal facts of one Project, newest
 * first, live. The Activity page is the plain summary; this page keeps type, sequence, actor and
 * resource for debugging. The rows come from the feed projection; the live socket only says that
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
          <PageTitle title="Event log" />
          <EmptyState
            what="Sign in to view this project's event log."
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
        title={<Term k="eventLog" />}
        meta={
          <span className="text-[14px]">
            The raw recorded events, for debugging. For a plain summary, open{" "}
            <Link
              to="/projects/$projectId/activity"
              params={{ projectId }}
              className="text-kumo-link underline-offset-2 hover:underline"
            >
              Activity
            </Link>
            .
          </span>
        }
        actions={
          changeId && (
            <Link
              to="/projects/$projectId/events"
              params={{ projectId }}
              search={{}}
              className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "gap-1.5")}
            >
              <X size={16} aria-hidden />
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

      <Section
        label="Events"
        meta={
          feed.pullError ? (
            <span className="text-kumo-warning" role="status">
              Live update failed. Retrying.
            </span>
          ) : (
            <Summary events={feed.events} loading={loading} live={live} />
          )
        }
      >
        {changeId && (
          <p className="text-[13px]">
            Showing one change:{" "}
            <Link
              to="/changes/$changeId"
              params={{ changeId }}
              className="font-mono text-[12px] text-kumo-link underline-offset-2 hover:underline"
            >
              {changeId}
            </Link>
          </p>
        )}
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
                      Start of the recorded log. Older events are in the audit archive.
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

      <SystemsOnly
        fallback={
          <p className="text-[12px] text-kumo-subtle">
            Technical details are hidden. Turn on &lsquo;Show technical details&rsquo; in the
            Advanced menu to see stream lag and retention.
          </p>
        }
      >
        <EventPlane projectId={projectId} events={feed.events} live={live} />
      </SystemsOnly>
    </Page>
  );
}

const LIVE_WORD: Record<LiveStatus, string> = {
  open: "live",
  connecting: "connecting",
  closed: "checking every 15s",
};

/** One sentence in place of the old stat strip: count, newest age, connection. */
function Summary({
  events,
  loading,
  live,
}: {
  events: FeedEvent[];
  loading: boolean;
  live: LiveStatus;
}) {
  if (loading) return <span>Loading</span>;
  const newest = events[0];
  return (
    <span>
      {formatNumber(events.length)} {events.length === 1 ? "event" : "events"}
      {newest && (
        <>
          {" "}
          · newest{" "}
          <time dateTime={newest.occurredAt} title={newest.occurredAt}>
            {formatAge(newest.occurredAt)}
          </time>
        </>
      )}{" "}
      · <span className={live === "open" ? "text-kumo-success" : undefined}>{LIVE_WORD[live]}</span>
    </span>
  );
}
