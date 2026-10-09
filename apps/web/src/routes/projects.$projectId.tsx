import { Show } from "@clerk/tanstack-react-start";
import { Badge, Button, Input, InputArea, LayerCard, Meter, Text } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { createChange, getProject, listChanges, provisionProject } from "../lib/api";
import { DEMO_GOAL, generation, timeAgo, truncate } from "../lib/format";

export const Route = createFileRoute("/projects/$projectId")({ component: ProjectPage });

function ProjectPage() {
  return (
    <main className="mx-auto grid max-w-5xl gap-6 px-6 py-8">
      <Show when="signed-in">
        <Overview />
      </Show>
      <Show when="signed-out">
        <Text variant="secondary">Sign in to view this project.</Text>
      </Show>
    </main>
  );
}

function Overview() {
  const { projectId } = Route.useParams();
  const [seeding, setSeeding] = useState(false);
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: projectId }),
    // Provisioning is asynchronous: poll until the canonical source is assigned.
    refetchInterval: (query) =>
      seeding && query.state.data?.canonical.artifactRef === "unassigned" ? 2000 : false,
  });
  const seed = useMutation({
    mutationFn: () => provisionProject({ data: { projectId, template: "acme-shop" } }),
    onSuccess: () => setSeeding(true),
  });
  const source = project.data?.canonical;
  const changes = useQuery({
    queryKey: ["changes", projectId],
    queryFn: () => listChanges({ data: projectId }),
    refetchInterval: (query) =>
      query.state.data?.some((c) => ["created", "compiling", "running"].includes(c.status))
        ? 2500
        : false,
  });
  return (
    <>
      <LayerCard>
        <LayerCard.Primary className="flex items-center justify-between gap-3 px-5 py-4">
          <div className="grid gap-1">
            <Text variant="secondary">Project</Text>
            <Text as="h1" variant="heading" size="lg">
              {project.data?.name ?? "Loading…"}
            </Text>
          </div>
          <div className="grid justify-items-end gap-1">
            <Text variant="secondary">Canonical Generation</Text>
            <span className="font-mono text-3xl font-semibold text-kumo-default">
              {project.data ? generation(project.data.canonical.generation) : "—"}
            </span>
            {source && source.artifactRef !== "unassigned" && (
              <Text variant="mono-secondary">
                {source.artifactRef} · tree {source.treeSha.slice(0, 10)}
              </Text>
            )}
            {source?.artifactRef === "unassigned" && (
              <Button
                size="sm"
                variant="secondary"
                loading={seed.isPending || seeding}
                onClick={() => seed.mutate()}
              >
                Seed Acme Shop source
              </Button>
            )}
          </div>
        </LayerCard.Primary>
      </LayerCard>
      <LayerCard>
        <LayerCard.Secondary className="px-5 py-2.5">
          <Text as="h2" variant="heading3">
            Changes
          </Text>
        </LayerCard.Secondary>
        <LayerCard.Primary className="grid gap-2 px-5 py-4">
          {changes.isPending && <Text variant="secondary">Loading changes…</Text>}
          {changes.isError && <Text variant="secondary">{changes.error.message}</Text>}
          {changes.data?.length === 0 && <Text variant="secondary">No Changes yet.</Text>}
          {changes.data?.map((change) => (
            <Link
              key={change.id}
              to="/changes/$changeId"
              params={{ changeId: change.id }}
              className="grid gap-2 rounded-lg border border-kumo-line px-3 py-2 hover:bg-kumo-tint"
            >
              <div className="flex items-start justify-between gap-3">
                <Text>{truncate(change.goal, 110)}</Text>
                <Badge variant={change.status === "completed" ? "success" : "info"}>
                  {change.status}
                </Badge>
              </div>
              <Meter
                label={`${change.completedCount}/${change.taskCount} Tasks`}
                value={
                  change.taskCount === 0 ? 0 : (change.completedCount / change.taskCount) * 100
                }
                showValue={false}
                customValue={timeAgo(change.createdAt)}
              />
            </Link>
          ))}
        </LayerCard.Primary>
      </LayerCard>
      <NewChange projectId={projectId} />
    </>
  );
}

function NewChange({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [goal, setGoal] = useState(DEMO_GOAL);
  const [budget, setBudget] = useState("3");
  const budgetUsd = Number(budget);
  const create = useMutation({
    mutationFn: () => createChange({ data: { projectId, goal: goal.trim(), budgetUsd } }),
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: ["changes", projectId] });
      await navigate({ to: "/changes/$changeId", params: { changeId: id } });
    },
  });
  return (
    <LayerCard>
      <LayerCard.Secondary className="px-5 py-2.5">
        <Text as="h2" variant="heading3">
          New Change
        </Text>
      </LayerCard.Secondary>
      <LayerCard.Primary className="px-5 py-4">
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <InputArea
            label="Goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={4}
            required
          />
          <div className="grid gap-3 sm:grid-cols-[10rem_auto] sm:items-end sm:justify-start">
            <Input
              label="Budget (USD)"
              type="number"
              min={0.1}
              step={0.1}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              required
            />
            <Button
              type="submit"
              variant="primary"
              loading={create.isPending}
              disabled={!goal.trim() || !(budgetUsd > 0)}
            >
              Submit Change
            </Button>
          </div>
          {create.isError && <Text variant="secondary">{create.error.message}</Text>}
        </form>
      </LayerCard.Primary>
    </LayerCard>
  );
}
