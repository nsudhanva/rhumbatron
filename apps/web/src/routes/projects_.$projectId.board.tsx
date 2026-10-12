import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Button } from "@cloudflare/kumo";
import { SignIn } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { ProjectBoardView } from "../components/board/board";
import { boardKey } from "../components/board/use-review";
import { EmptyState } from "../components/ui/empty-state";
import { Page, PageTitle } from "../components/ui/page";
import { getProjectBoard } from "../lib/api-board";
import { loadOnServer, prefetch, prefetchProjectShell } from "../lib/ssr-data";

/**
 * Board of one Project: every request as a card by person and stage (shared-projects.md,
 * "Board"). The trailing underscore keeps this page out of the Project page's layout; the shell
 * adds "Board" to the breadcrumb and marks the sidebar item.
 */
export const Route = createFileRoute("/projects_/$projectId/board")({
  // Server render: the lanes and cards are in the first HTML (lib/ssr-data.ts).
  loader: ({ context: { queryClient }, params: { projectId } }) =>
    loadOnServer(queryClient, () =>
      Promise.all([
        prefetchProjectShell(queryClient, projectId),
        prefetch(queryClient, boardKey(projectId), () => getProjectBoard({ data: projectId })),
      ]),
    ),
  component: BoardPage,
});

function BoardPage() {
  const { projectId } = Route.useParams();
  return (
    <>
      <Show when="signed-in">
        <Page>
          <PageTitle kicker="Project" title="Board" />
          <ProjectBoardView projectId={projectId} />
        </Page>
      </Show>
      <Show when="signed-out">
        <Page>
          <PageTitle kicker="Project" title="Board" />
          <EmptyState
            what="Sign in to see this project's board."
            how="The board is visible to the project's members."
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
