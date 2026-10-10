import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Button, Input } from "@cloudflare/kumo";
import { SignIn } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { SectionError, SkeletonRows } from "../components/project/feedback";
import { ProjectStatusPill } from "../components/project/status";
import { DataTable, RowLink, Td, Th, TitleCell, TRow } from "../components/ui/data-table";
import { EmptyState } from "../components/ui/empty-state";
import { Mono } from "../components/ui/mono";
import { Page, PageTitle, Section } from "../components/ui/page";
import { createProject, listProjects } from "../lib/api";
import { formatAge, formatNumber, generation } from "../lib/format";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Projects · Rhumbatron" },
      {
        name: "description",
        content:
          "Your Rhumbatron projects: one canonical state per codebase, advanced only by verified evidence.",
      },
    ],
  }),
  component: Home,
});

function Home() {
  return (
    <Page>
      <PageTitle kicker="Rhumbatron" title="Projects" />
      <Show when="signed-out">
        <SignedOut />
      </Show>
      <Show when="signed-in">
        <Projects />
        <NewProject />
      </Show>
    </Page>
  );
}

function SignedOut() {
  return (
    <Section label="Projects">
      <EmptyState
        what="Sign in to see your projects."
        how="Many agents can propose many futures. Only verified evidence can advance the canonical state."
        action={
          <SignInButton>
            <Button variant="primary" icon={SignIn}>
              Sign in
            </Button>
          </SignInButton>
        }
      />
    </Section>
  );
}

function Projects() {
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => listProjects() });
  const count = projects.data?.length;
  return (
    <Section
      label="Projects"
      meta={
        projects.isPending ? (
          <span role="status">Loading</span>
        ) : count !== undefined ? (
          <Mono subtle>{formatNumber(count)}</Mono>
        ) : null
      }
    >
      {projects.isError ? (
        <SectionError
          message={`Projects could not load. ${projects.error.message}`}
          onRetry={() => projects.refetch()}
          retrying={projects.isFetching}
        />
      ) : count === 0 ? (
        <EmptyState
          what="No projects yet."
          how="Create one under New project. It starts empty, and agents build the app from your first request."
        />
      ) : (
        <DataTable label="Projects" minWidth={560}>
          <thead>
            <tr>
              <Th>Project</Th>
              <Th>Status</Th>
              <Th numeric>Generation</Th>
              <Th numeric>Created</Th>
            </tr>
          </thead>
          <tbody aria-busy={projects.isPending || undefined}>
            {projects.isPending ? (
              <SkeletonRows cells={["title", 56, "numeric", "numeric"]} />
            ) : (
              projects.data?.map((project) => (
                <TRow key={project.id}>
                  <Td>
                    <TitleCell
                      title={
                        <RowLink to="/projects/$projectId" params={{ projectId: project.id }}>
                          {project.name}
                        </RowLink>
                      }
                      meta={`${project.slug} · ${project.id}`}
                    />
                  </Td>
                  <Td>
                    <ProjectStatusPill status={project.status} />
                  </Td>
                  <Td numeric>{generation(project.canonicalGeneration)}</Td>
                  <Td numeric className="text-kumo-subtle">
                    <time dateTime={project.createdAt} title={project.createdAt}>
                      {formatAge(project.createdAt)}
                    </time>
                  </Td>
                </TRow>
              ))
            )}
          </tbody>
        </DataTable>
      )}
    </Section>
  );
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function NewProject() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const create = useMutation({
    mutationFn: () => createProject({ data: { name: name.trim(), slug } }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
    },
  });
  const slugInvalid = slug !== "" && !SLUG.test(slug);
  return (
    <Section label="New project">
      <form
        className="grid max-w-[760px] gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
          <Input
            label="Name"
            description="Shown in navigation and breadcrumbs."
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Input
            label="Slug"
            className="font-mono"
            description="Lowercase letters, numbers and hyphens. Names the project's resources."
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            {...(slugInvalid ? { error: "Use lowercase kebab-case, for example my-app" } : {})}
            required
          />
        </div>
        {create.isError && (
          <SectionError message={`The project was not created. ${create.error.message}`} />
        )}
        <div>
          <Button
            type="submit"
            variant="primary"
            loading={create.isPending}
            disabled={!name.trim() || !SLUG.test(slug)}
          >
            Create project
          </Button>
        </div>
      </form>
    </Section>
  );
}
