import { Show } from "@clerk/tanstack-react-start";
import { Badge, LayerCard, Loader, Meter, Text } from "@cloudflare/kumo";
import { Robot, ShieldCheck } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { TaskPanel } from "../components/task-detail";
import { WorkGraph } from "../components/work-graph";
import { getChange, listTasks, type TaskDetail } from "../lib/api";
import {
  formatUsd,
  generation,
  isCompiling,
  isLive,
  lastActiveTask,
  latestRun,
} from "../lib/format";

export const Route = createFileRoute("/changes/$changeId")({ component: ChangePage });

function ChangePage() {
  return (
    <main className="mx-auto grid max-w-7xl gap-4 px-6 py-8">
      <Show when="signed-in">
        <ChangeView />
      </Show>
      <Show when="signed-out">
        <Text variant="secondary">Sign in to view this Change.</Text>
      </Show>
    </main>
  );
}

function ChangeView() {
  const { changeId } = Route.useParams();
  const [selected, setSelected] = useState<string>();
  const change = useQuery({
    queryKey: ["change", changeId],
    queryFn: () => getChange({ data: changeId }),
    refetchInterval: (query) => (isLive(query.state.data, undefined) ? 2500 : false),
  });
  const tasks = useQuery({
    queryKey: ["tasks", changeId],
    queryFn: () => listTasks({ data: changeId }),
    refetchInterval: (query) => (isLive(change.data, query.state.data) ? 2500 : false),
  });

  if (change.isError) return <Text variant="secondary">{change.error.message}</Text>;
  if (!change.data) return <Text variant="secondary">Loading Change…</Text>;

  const data = change.data;
  const taskList = tasks.data ?? [];
  const completed = taskList.filter((t) => t.status === "completed").length;
  const live = isLive(data, tasks.data);
  const selectedTask = taskList.find((t) => t.id === selected) ?? lastActiveTask(taskList);

  return (
    <>
      <LayerCard>
        <LayerCard.Primary className="grid gap-3 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={data.status === "completed" ? "success" : "info"}>{data.status}</Badge>
            <Badge variant="secondary">Base {generation(data.baseGeneration)}</Badge>
            <Badge variant="secondary">Budget {formatUsd(data.budgetUsd)}</Badge>
            {live && (
              <span
                className="ml-auto flex items-center gap-1.5 text-sm text-kumo-success"
                role="status"
              >
                <span className="size-2 animate-pulse rounded-full bg-kumo-success" />
                Live
              </span>
            )}
          </div>
          <Text as="h1" variant="heading3">
            {data.goal}
          </Text>
          <Meter
            label="Tasks completed"
            value={taskList.length === 0 ? 0 : (completed / taskList.length) * 100}
            customValue={`${completed}/${taskList.length}`}
          />
        </LayerCard.Primary>
      </LayerCard>

      {isCompiling(data.status) && taskList.length === 0 ? (
        <LayerCard>
          <LayerCard.Primary className="flex items-center gap-3 px-5 py-6">
            <Loader />
            <Text>Root Planner is compiling the Work Graph…</Text>
          </LayerCard.Primary>
        </LayerCard>
      ) : (
        <div className="grid gap-4 min-[900px]:grid-cols-[18rem_1fr_24rem]">
          <div className="grid content-start gap-4">
            <LayerCard>
              <LayerCard.Secondary className="px-5 py-2.5">
                <Text as="h2" variant="heading3">
                  Acceptance criteria
                </Text>
              </LayerCard.Secondary>
              <LayerCard.Primary className="px-5 py-4">
                <ul className="list-disc pl-5 text-sm text-kumo-default">
                  {data.acceptanceCriteria.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </LayerCard.Primary>
            </LayerCard>
            <LayerCard>
              <LayerCard.Secondary className="px-5 py-2.5">
                <Text as="h2" variant="heading3">
                  Protected invariants
                </Text>
              </LayerCard.Secondary>
              <LayerCard.Primary className="grid gap-2 px-5 py-4">
                {data.invariants.map((item) => (
                  <div key={item} className="flex gap-2 text-sm text-kumo-default">
                    <ShieldCheck
                      size={18}
                      weight="fill"
                      className="mt-0.5 shrink-0 text-kumo-success"
                    />
                    <span>{item}</span>
                  </div>
                ))}
              </LayerCard.Primary>
            </LayerCard>
          </div>
          <div className="grid min-w-0 content-start gap-4">
            <AgentsStrip tasks={taskList} />
            <WorkGraph tasks={taskList} selectedId={selectedTask?.id} onSelect={setSelected} />
          </div>
          <LayerCard className="min-w-0 content-start">
            <LayerCard.Secondary className="px-5 py-2.5">
              <Text as="h2" variant="heading3">
                Task details
              </Text>
            </LayerCard.Secondary>
            <LayerCard.Primary className="px-5 py-4">
              <TaskPanel task={selectedTask} />
            </LayerCard.Primary>
          </LayerCard>
        </div>
      )}
    </>
  );
}

function AgentsStrip({ tasks }: { tasks: TaskDetail[] }) {
  const active = tasks.filter((t) => t.assignedAgentId && latestRun(t));
  const sleeping = tasks.filter((t) => !t.assignedAgentId || !latestRun(t)).length;
  return (
    <ul className="flex flex-wrap items-center gap-2" aria-label="Agents">
      {active.map((task) => {
        const run = latestRun(task);
        return (
          <li
            key={task.id}
            className="flex items-center gap-1.5 rounded-full border border-kumo-line bg-kumo-base px-2.5 py-1 text-sm"
          >
            <Robot size={16} />
            <span className="font-mono text-xs">agent {task.key}</span>
            <Badge variant="info">{run?.tier}</Badge>
            <span className="text-kumo-subtle">{run?.status}</span>
          </li>
        );
      })}
      <li>
        <Text variant="secondary">{sleeping} sleeping or pending</Text>
      </li>
    </ul>
  );
}
