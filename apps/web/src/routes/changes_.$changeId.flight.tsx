import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Button } from "@cloudflare/kumo";
import { SignIn } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { FlightPage, FlightSkeleton } from "../components/flight/flight-page";
import { useFlightData } from "../components/flight/use-flight-data";
import { usePageMeta } from "../components/shell/page-meta";
import { EmptyState } from "../components/ui/empty-state";
import { Page, PageTitle } from "../components/ui/page";
import { Term } from "../components/ui/term";

/**
 * Debug view for one Change (was Flight Control; AGENTS.md 38, 39): every recorded fact of the
 * Change in synchronized panels with a time machine. An Advanced page, so it keeps the technical
 * vocabulary. The trailing underscore keeps this page out of the Change page's layout; the shell
 * marks the "Debug view" sidebar item.
 */
export const Route = createFileRoute("/changes_/$changeId/flight")({
  head: () => ({
    meta: [
      { title: "Debug view · Rhumbatron" },
      {
        name: "description",
        content:
          "Debug view for one Rhumbatron change: every recorded fact in one place, with agent lanes, the task graph, decisions and check results at any recorded instant.",
      },
    ],
  }),
  component: FlightRoute,
});

function FlightRoute() {
  return (
    <>
      <Show when="signed-in">
        <FlightView />
      </Show>
      <Show when="signed-out">
        <Page>
          <EmptyState
            what="Sign in to open the Debug view."
            how="Changes are visible to members of their organization."
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

const INTRO =
  "Every recorded fact of this change in one place: lanes, graph, decisions, check results. For debugging.";

function FlightView() {
  const { changeId } = Route.useParams();
  const { model, ready, socket, error, projectId } = useFlightData(changeId);
  usePageMeta({ trail: [{ label: "Debug view" }] });

  return (
    <Page width="full" gap="tight">
      <PageTitle title={<Term k="debugView" />} meta={<span>{INTRO}</span>} />
      {error ? (
        <p className="rounded-lg bg-kumo-danger-tint px-3 py-2 text-[13px] font-semibold text-kumo-danger">
          {error}
        </p>
      ) : model ? (
        <FlightPage
          model={model}
          ready={ready}
          socket={socket}
          projectId={projectId ?? model.input.change.projectId}
          changeId={changeId}
        />
      ) : (
        <FlightSkeleton />
      )}
    </Page>
  );
}
