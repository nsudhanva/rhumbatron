import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Badge, Button, Checkbox, Input, LayerCard, Text } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { createProject, listProjects } from "../lib/api";
import { generation, timeAgo } from "../lib/format";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <main className="mx-auto grid max-w-5xl gap-6 px-6 py-8">
      <Show when="signed-out">
        <LayerCard>
          <LayerCard.Primary className="grid gap-3 px-5 py-6">
            <Text as="h1" variant="heading" size="lg">
              Rhumbatron
            </Text>
            <Text variant="secondary">
              Many Agents can propose many futures. Only verified evidence can advance the Canonical
              State.
            </Text>
            <div>
              <SignInButton>
                <Button variant="primary">Sign in to open your projects</Button>
              </SignInButton>
            </div>
          </LayerCard.Primary>
        </LayerCard>
      </Show>
      <Show when="signed-in">
        <Projects />
      </Show>
    </main>
  );
}

function Projects() {
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => listProjects() });
  return (
    <>
      <LayerCard>
        <LayerCard.Secondary className="px-5 py-2.5">
          <Text as="h1" variant="heading3">
            Projects
          </Text>
        </LayerCard.Secondary>
        <LayerCard.Primary className="grid gap-2 px-5 py-4">
          {projects.isPending && <Text variant="secondary">Loading projects…</Text>}
          {projects.isError && <Text variant="secondary">{projects.error.message}</Text>}
          {projects.data?.length === 0 && (
            <Text variant="secondary">No projects yet. Create one below.</Text>
          )}
          {projects.data?.map((project) => (
            <Link
              key={project.id}
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              className="flex items-center justify-between gap-3 rounded-lg border border-kumo-line px-3 py-2 hover:bg-kumo-tint"
            >
              <div className="grid">
                <Text bold>{project.name}</Text>
                <Text variant="mono-secondary">{project.slug}</Text>
              </div>
              <div className="flex items-center gap-3">
                <Text variant="secondary">{timeAgo(project.createdAt)}</Text>
                <Badge variant="info">{generation(project.canonicalGeneration)}</Badge>
              </div>
            </Link>
          ))}
        </LayerCard.Primary>
      </LayerCard>
      <NewProject />
    </>
  );
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function NewProject() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [demo, setDemo] = useState(true);
  const create = useMutation({
    mutationFn: () =>
      createProject({ data: { name: name.trim(), slug, template: demo ? "acme-shop" : "empty" } }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
    },
  });
  const slugInvalid = slug !== "" && !SLUG.test(slug);
  return (
    <LayerCard>
      <LayerCard.Secondary className="px-5 py-2.5">
        <Text as="h2" variant="heading3">
          New project
        </Text>
      </LayerCard.Secondary>
      <LayerCard.Primary className="px-5 py-4">
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Input
            label="Slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            {...(slugInvalid ? { error: "Use lowercase kebab-case" } : {})}
            required
          />
          <div className="sm:col-span-3 sm:order-last">
            <Checkbox
              label="Start from the Acme Shop demo codebase"
              checked={demo}
              onCheckedChange={(checked) => setDemo(checked === true)}
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            loading={create.isPending}
            disabled={!name.trim() || !SLUG.test(slug)}
          >
            Create project
          </Button>
        </form>
        {create.isError && <Text variant="secondary">{create.error.message}</Text>}
      </LayerCard.Primary>
    </LayerCard>
  );
}
