import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Button } from "@cloudflare/kumo";
import { SignIn } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { preloadChange } from "../components/change/preload-change";
import { FlightPage, FlightSkeleton } from "../components/flight/flight-page";
import { useFlightData } from "../components/flight/use-flight-data";
import { EmptyState } from "../components/ui/empty-state";
import { Page } from "../components/ui/page";
import { getChangeDecisions, getWorkspace } from "../lib/api";
import { loadChange, loadOnServer, prefetch } from "../lib/ssr-data";

/**
 * Flight Control for one Change (AGENTS.md 38, 39): every recorded fact of the Change in
 * synchronized panels with a time machine. The trailing underscore keeps this page out of the
 * Change page's layout; the shell marks the "Flight Control" sidebar item.
 */
export const Route = createFileRoute("/changes_/$changeId/flight")({
  head: () => ({
    meta: [
      { title: "Flight Control · Rhumbatron" },
      {
        name: "description",
        content:
          "Flight Control for one Rhumbatron Change: agents, Work Graph, workspaces, conflicts, Candidates, evidence and decisions at any recorded instant.",
      },
    ],
  }),
  // Server render: every panel's facts are in the first HTML (lib/ssr-data.ts). The Change
  // page's reads plus the two Flight Control adds: the Project workspace and the Decisions.
  loader: ({ context: { queryClient }, params: { changeId } }) =>
    loadOnServer(queryClient, () =>
      Promise.allSettled([
        preloadChange(queryClient, changeId),
        loadChange(queryClient, changeId).then((change) =>
          prefetch(queryClient, ["workspace", change.projectId], () =>
            getWorkspace({ data: change.projectId }),
          ),
        ),
        prefetch(queryClient, ["change-decisions", changeId], () =>
          getChangeDecisions({ data: changeId }),
        ),
      ]),
    ),
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
            what="Sign in to open Flight Control."
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

function FlightView() {
  const { changeId } = Route.useParams();
  const { model, ready, socket, error, projectId } = useFlightData(changeId);

  return (
    <Page width="full" gap="tight">
      {error ? (
        <p className="bg-accent-100 px-3 py-2 text-[13px] font-semibold text-kumo-danger">
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
        <>
          <h1 className="sr-only">Flight Control</h1>
          <FlightSkeleton />
        </>
      )}
    </Page>
  );
}
