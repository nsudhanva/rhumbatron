import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Button } from "@cloudflare/kumo";
import { SignIn } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SectionError, SkeletonBar } from "../components/project/feedback";
import { ProjectRemove } from "../components/project/remove-dialog";
import { ProjectPeople } from "../components/project/share-dialog";
import { DefaultsSection } from "../components/settings/defaults-section";
import { DisplaySection } from "../components/settings/display-section";
import { GeneralSection } from "../components/settings/general-section";
import { EmptyState } from "../components/ui/empty-state";
import { Page, PageTitle, Section, TwoUp } from "../components/ui/page";
import { getProjectApp, getProjectMembers } from "../lib/api";
import { getProjectSettings } from "../lib/api-settings";
import { asRole, can } from "../lib/permissions";
import { loadOnServer, prefetch, prefetchProjectShell } from "../lib/ssr-data";

/**
 * Project Settings (last navigation item): General, People, Defaults, Display and
 * Danger zone. Fields a role cannot change are hidden, not disabled (lib/permissions.ts); the
 * API enforces the same rules.
 */
export const Route = createFileRoute("/projects_/$projectId/settings")({
  // Server render: every section, with its current values, is in the first HTML.
  loader: ({ context: { queryClient }, params: { projectId } }) =>
    loadOnServer(queryClient, () =>
      Promise.all([
        prefetchProjectShell(queryClient, projectId),
        prefetch(queryClient, ["project-settings", projectId], () =>
          getProjectSettings({ data: projectId }),
        ),
        prefetch(queryClient, ["project-members", projectId], () =>
          getProjectMembers({ data: projectId }),
        ),
        prefetch(queryClient, ["project-app", projectId], () => getProjectApp({ data: projectId })),
      ]),
    ),
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <>
      <Show when="signed-in">
        <SettingsContent />
      </Show>
      <Show when="signed-out">
        <Page>
          <PageTitle kicker="Project" title="Settings" />
          <EmptyState
            what="Sign in to see this project's settings."
            how="Settings are visible to the project's members."
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

function SettingsContent() {
  const { projectId } = Route.useParams();
  const settings = useQuery({
    queryKey: ["project-settings", projectId],
    queryFn: () => getProjectSettings({ data: projectId }),
  });
  const data = settings.data;
  const role = asRole(data?.role);
  const edits = can(role, "settings.edit");
  const owner = can(role, "project.delete");

  return (
    <Page>
      <PageTitle
        kicker="Project"
        title="Settings"
        meta={
          data && !edits ? (
            <span>Only the project owner or an admin can change these.</span>
          ) : undefined
        }
      />

      {settings.isError ? (
        <SectionError
          message={`Settings could not load. ${settings.error.message}`}
          onRetry={() => settings.refetch()}
          retrying={settings.isFetching}
        />
      ) : !data ? (
        <Section label="General">
          <div className="grid gap-2" role="status" aria-label="Loading settings">
            <SkeletonBar height={13} className="w-1/2" />
            <SkeletonBar height={13} className="w-1/3" />
            <SkeletonBar height={13} className="w-2/5" />
          </div>
        </Section>
      ) : (
        <>
          <GeneralSection projectId={projectId} settings={data} />

          <Section label="People">
            <ProjectPeople projectId={projectId} role={role} />
          </Section>

          <TwoUp>
            <DefaultsSection projectId={projectId} settings={data} />
            <DisplaySection />
          </TwoUp>

          <Section label="Danger zone">
            <div className="grid justify-items-start gap-3">
              <p className="max-w-[760px] text-[13px] text-kumo-subtle">
                {owner
                  ? "Deleting removes the project's source, previews, live app, app data, evidence and request history. It cannot be undone."
                  : "Leaving removes your access. Your open requests are cancelled; finished ones stay with the project."}
              </p>
              <ProjectRemove projectId={projectId} projectName={data.name} role={data.role} />
            </div>
          </Section>
        </>
      )}
    </Page>
  );
}
