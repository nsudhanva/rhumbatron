import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Button } from "@cloudflare/kumo";
import { SignIn } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { ActivityFeed } from "../components/project/event-stream";
import { useEventFeed } from "../components/project/use-event-feed";
import { EmptyState } from "../components/ui/empty-state";
import { Page, PageTitle } from "../components/ui/page";
import { useProjectLive } from "../lib/live";

/**
 * Activity of one Project (research 7.1): every change, in plain sentences, newest first. The
 * trailing underscore keeps this page out of the Project page's layout; the shell adds
 * "Activity" to the breadcrumb and marks the sidebar item. The raw table is the Event log.
 */
export const Route = createFileRoute("/projects_/$projectId/activity")({
  component: ActivityPage,
});

/** Safety net while the live socket is down. */
const FALLBACK_POLL_MS = 30_000;

function ActivityPage() {
  return (
    <>
      <Show when="signed-in">
        <Activity />
      </Show>
      <Show when="signed-out">
        <Page>
          <PageTitle title="Activity" />
          <EmptyState
            what="Sign in to see what happened in this project."
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

function Activity() {
  const { projectId } = Route.useParams();
  const feed = useEventFeed({ kind: "project", projectId }, { initial: 100 });
  const { refresh } = feed;
  // Each live push means new events were recorded; the feed reads only rows after its cursor.
  const socket = useProjectLive(projectId, true, refresh);
  useEffect(() => {
    if (socket === "open") return;
    const timer = setInterval(refresh, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [socket, refresh]);

  return (
    <Page>
      <PageTitle
        title="Activity"
        meta={<span>What happened in this project, newest first.</span>}
      />
      <div className="max-w-[880px]">
        <ActivityFeed
          events={feed.events}
          loading={feed.loading}
          error={feed.error}
          onRetry={refresh}
        />
      </div>
    </Page>
  );
}
