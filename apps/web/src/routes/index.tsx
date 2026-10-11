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
import { acceptInvitation, createProject, listProjects, listUserInvitations } from "../lib/api";
import { formatAge, formatNumber, generation } from "../lib/format";
import { loadOnServer, prefetch } from "../lib/ssr-data";

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
  // Server render: the project list is in the first HTML (lib/ssr-data.ts).
  loader: ({ context: { queryClient } }) =>
    loadOnServer(queryClient, () =>
      Promise.all([
        prefetch(queryClient, ["projects"], () => listProjects()),
        prefetch(queryClient, ["user-invitations"], () => listUserInvitations()),
      ]),
    ),
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
        <SharedWithYou />
        <Projects />
        <NewProject />
      </Show>
    </Page>
  );
}

function SharedWithYou() {
  const queryClient = useQueryClient();
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invitations = useQuery({
    queryKey: ["user-invitations"],
    queryFn: () => listUserInvitations(),
  });

  const accept = useMutation({
    mutationFn: (invitationId: string) => acceptInvitation({ data: invitationId }),
    onMutate: (invitationId) => {
      setAcceptingId(invitationId);
      setError(null);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["user-invitations"] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
    onError: (err) => {
      setError(err.message);
    },
    onSettled: () => {
      setAcceptingId(null);
    },
  });

  const items = invitations.data;
  if (!items || items.length === 0) return null;

  return (
    <Section label="Shared with you" meta={<Mono subtle>{formatNumber(items.length)}</Mono>}>
      {error && <p className="text-[12px] text-kumo-danger font-medium mb-2">{error}</p>}
      <DataTable label="Shared with you" minWidth={560}>
        <thead>
          <tr>
            <Th>Project</Th>
            <Th>Invited by</Th>
            <Th numeric>Action</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((inv) => (
            <TRow key={inv.id}>
              <Td>
                <TitleCell title={inv.projectName} meta={inv.projectId} />
              </Td>
              <Td className="text-kumo-subtle">
                {inv.invitedBy ? `Invited by ${inv.invitedBy}` : "Invited by owner"}
              </Td>
              <Td numeric>
                <Button
                  size="sm"
                  variant="primary"
                  loading={accept.isPending && acceptingId === inv.id}
                  onClick={() => accept.mutate(inv.id)}
                >
                  Accept
                </Button>
              </Td>
            </TRow>
          ))}
        </tbody>
      </DataTable>
    </Section>
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
  // Field errors show after a submit attempt, or as soon as a typed slug has the wrong shape.
  const [submitted, setSubmitted] = useState(false);
  const nameError = submitted && !name.trim() ? "Enter a name." : undefined;
  const slugError =
    slug === ""
      ? submitted
        ? "Enter a slug, for example my-app."
        : undefined
      : SLUG.test(slug)
        ? undefined
        : "Use lowercase kebab-case, for example my-app";
  return (
    <Section label="New project">
      <form
        className="grid max-w-[760px] gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (create.isPending || !name.trim() || !SLUG.test(slug)) return;
          create.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
          <Input
            label="Name"
            description="Shown in navigation and breadcrumbs."
            value={name}
            onChange={(e) => setName(e.target.value)}
            {...(nameError ? { error: nameError } : {})}
            required
          />
          <Input
            label="Slug"
            className="font-mono"
            description="Lowercase letters, numbers and hyphens. Names the project's resources."
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            {...(slugError ? { error: slugError } : {})}
            required
          />
        </div>
        {create.isError && (
          <SectionError message={`The project was not created. ${create.error.message}`} />
        )}
        <div>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create project
          </Button>
        </div>
      </form>
    </Section>
  );
}
