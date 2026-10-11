import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Button } from "@cloudflare/kumo";
import { SignIn } from "@phosphor-icons/react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AgentsView } from "../components/agents-page/agents-view";
import type { DagMode } from "../components/dag/view-toggle";
import { EmptyState } from "../components/ui/empty-state";
import { Page, PageTitle } from "../components/ui/page";

/**
 * Agents of one Project (AGENTS.md 38.6). The trailing underscore keeps this page out of the
 * Project page's layout; the shell adds "Agents" to the breadcrumb and marks the sidebar item.
 * `?view=list` shows the tables; the graph is the default.
 */
type AgentsSearch = { view?: DagMode };

export const Route = createFileRoute("/projects_/$projectId/agents")({
  validateSearch: (search: Record<string, unknown>): AgentsSearch =>
    search.view === "list" || search.view === "graph" ? { view: search.view } : {},
  component: AgentsPage,
});

function AgentsPage() {
  const { projectId } = Route.useParams();
  const { view } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const mode: DagMode = view ?? "graph";
  return (
    <>
      <Show when="signed-in">
        <AgentsView
          projectId={projectId}
          mode={mode}
          onMode={(next) => void navigate({ search: { view: next }, replace: true })}
        />
      </Show>
      <Show when="signed-out">
        <Page>
          <PageTitle kicker="Project" title="Agents" />
          <EmptyState
            what="Sign in to view the agents of this project."
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
