import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Button, Dialog, Input, Radio } from "@cloudflare/kumo";
import { CaretRight, Plus, SignIn, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { NOTIFICATION_KEYS } from "../components/notifications/notification-keys";
import { SectionError, SkeletonBar } from "../components/project/feedback";
import { EmptyState } from "../components/ui/empty-state";
import { Page, PageTitle } from "../components/ui/page";
import { StatusPill } from "../components/ui/status-pill";
import { Term } from "../components/ui/term";
import {
  type AppNotification,
  createProject,
  listNotifications,
  listProjects,
  type ProjectSummary,
} from "../lib/api";
import { generation, timeAgo } from "../lib/format";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Projects · Rhumbatron" },
      {
        name: "description",
        content:
          "Your Rhumbatron projects. Describe a change, let agents build it, and ship the version that passes its checks.",
      },
    ],
  }),
  component: Home,
});

function Home() {
  const [creating, setCreating] = useState(false);
  return (
    <Page>
      <PageTitle
        title="Projects"
        meta={
          <span>
            Open a project to start a <Term k="change">change</Term> or follow one in progress.
          </span>
        }
        actions={
          <Show when="signed-in">
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
              New project
            </Button>
          </Show>
        }
      />
      <Show when="signed-out">
        <SignedOut />
      </Show>
      <Show when="signed-in">
        <Projects onCreate={() => setCreating(true)} />
        <NewProjectDialog open={creating} onOpenChange={setCreating} />
      </Show>
    </Page>
  );
}

function SignedOut() {
  return (
    <EmptyState
      what="Sign in to see your projects."
      how="Projects are visible to members of their organization."
      action={
        <SignInButton>
          <Button variant="primary" icon={SignIn}>
            Sign in
          </Button>
        </SignInButton>
      }
    />
  );
}

/** Open action items per project, split into approvals and everything else that needs a person. */
function actionsByProject(items: AppNotification[] | undefined) {
  const counts = new Map<string, { approvals: number; other: number }>();
  for (const item of items ?? []) {
    if (item.severity !== "action") continue;
    const entry = counts.get(item.projectId) ?? { approvals: 0, other: 0 };
    if (item.kind === "approval_required" || item.kind === "promotion_ready") entry.approvals += 1;
    else entry.other += 1;
    counts.set(item.projectId, entry);
  }
  return counts;
}

function Projects({ onCreate }: { onCreate: () => void }) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => listProjects() });
  // Shares the inbox cache. A failure here only hides the badges; the list still renders.
  const inbox = useQuery({
    queryKey: NOTIFICATION_KEYS.list,
    queryFn: () => listNotifications(),
    staleTime: 30_000,
    retry: 1,
  });
  const actions = actionsByProject(inbox.data?.items);

  if (projects.isError) {
    return (
      <SectionError
        message={`Projects could not load. ${projects.error.message}`}
        onRetry={() => projects.refetch()}
        retrying={projects.isFetching}
      />
    );
  }
  if (projects.data?.length === 0) {
    return (
      <EmptyState
        what="No projects yet."
        how="Create one to describe a change and let agents build it."
        action={
          <Button variant="primary" icon={Plus} onClick={onCreate}>
            New project
          </Button>
        }
      />
    );
  }
  return (
    <ul
      aria-label="Projects"
      aria-busy={projects.isPending || undefined}
      className="grid max-w-[880px] overflow-hidden rounded-lg border border-kumo-rule bg-kumo-elevated"
    >
      {projects.isPending
        ? [0, 1, 2].map((i) => (
            <li
              key={i}
              aria-hidden
              className="grid gap-2 border-b border-kumo-rule px-4 py-3.5 last:border-b-0"
            >
              <SkeletonBar height={16} className="w-[min(50%,240px)]" />
              <SkeletonBar height={12} className="w-[min(35%,180px)]" />
            </li>
          ))
        : projects.data?.map((project) => (
            <ProjectRow key={project.id} project={project} actions={actions.get(project.id)} />
          ))}
    </ul>
  );
}

function ProjectRow({
  project,
  actions,
}: {
  project: ProjectSummary;
  actions: { approvals: number; other: number } | undefined;
}) {
  const badge = actions
    ? actions.approvals > 0
      ? `${actions.approvals} ${actions.approvals === 1 ? "needs" : "need"} your approval`
      : actions.other > 0
        ? `${actions.other} ${actions.other === 1 ? "needs" : "need"} you`
        : null
    : null;
  return (
    <li className="border-b border-kumo-rule last:border-b-0">
      <Link
        to="/projects/$projectId"
        params={{ projectId: project.id }}
        className="flex items-center gap-4 px-4 py-3.5 transition-colors duration-(--rh-dur-ui) hover:bg-kumo-tint focus-visible:outline-offset-[-2px]"
      >
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-[16px] font-semibold">{project.name}</span>
          <span className="text-[12px] text-kumo-subtle">
            {generation(project.canonicalGeneration)} · created{" "}
            <time dateTime={project.createdAt} title={project.createdAt}>
              {timeAgo(project.createdAt)}
            </time>
          </span>
        </span>
        {badge && <StatusPill status="awaiting_approval" family="attention" label={badge} />}
        <CaretRight size={16} aria-hidden className="shrink-0 text-kumo-subtle" />
      </Link>
    </li>
  );
}

/** `Acme Shop!` -> `acme-shop`. */
const slugFrom = (name: string) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  /** Null until the user edits the slug; until then it follows the name. */
  const [slugInput, setSlugInput] = useState<string | null>(null);
  const [template, setTemplate] = useState<"empty" | "acme-shop">("acme-shop");
  const slug = slugInput ?? slugFrom(name);
  const create = useMutation({
    mutationFn: () => createProject({ data: { name: name.trim(), slug, template } }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      onOpenChange(false);
      await navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
    },
  });
  const slugInvalid = slug !== "" && !SLUG.test(slug);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!create.isPending) onOpenChange(next);
      }}
    >
      <Dialog size="lg" className="grid max-h-[calc(100dvh-32px)] gap-4 overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3">
          <Dialog.Title className="type-h4">New project</Dialog.Title>
          <Dialog.Close
            aria-label="Close"
            title="Close"
            disabled={create.isPending}
            className="-mt-1 -mr-1 grid size-7 place-items-center rounded-md text-kumo-subtle hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-accent-500"
          >
            <X size={16} aria-hidden />
          </Dialog.Close>
        </div>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Shop"
            required
          />
          <Radio.Group
            legend="Start from"
            value={template}
            onValueChange={(value) => setTemplate(value === "empty" ? "empty" : "acme-shop")}
          >
            <Radio.Item value="empty" label="Empty project" />
            <Radio.Item
              value="acme-shop"
              label="Acme Shop demo"
              description="A small shop with a catalog, a cart and a test sign-in."
            />
          </Radio.Group>
          <details className="text-[13px]" open={slugInvalid || undefined}>
            <summary className="w-fit cursor-pointer text-kumo-subtle select-none hover:text-kumo-default">
              More options
            </summary>
            <div className="mt-3">
              <Input
                label="Short name (slug)"
                className="font-mono"
                description="Lowercase letters, numbers and hyphens. Used in resource names."
                value={slug}
                onChange={(e) => setSlugInput(e.target.value)}
                {...(slugInvalid
                  ? { error: "Use lowercase words joined by hyphens, for example acme-shop" }
                  : {})}
              />
            </div>
          </details>
          {create.isError && (
            <SectionError message={`The project was not created. ${create.error.message}`} />
          )}
          <div className="flex justify-end gap-2">
            <Dialog.Close
              render={
                <Button variant="secondary" disabled={create.isPending}>
                  Cancel
                </Button>
              }
            />
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
      </Dialog>
    </Dialog.Root>
  );
}
