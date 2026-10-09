import { Show } from "@clerk/tanstack-react-start";
import { Badge, LayerCard, Loader, Meter, Text } from "@cloudflare/kumo";
import { Robot, ShieldCheck } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CandidateList } from "../components/candidate-list";
import { ConflictCard } from "../components/conflict-card";
import { TaskPanel } from "../components/task-detail";
import { WorkGraph } from "../components/work-graph";
import { getChange, getConflicts, listCandidates, listTasks, type TaskDetail } from "../lib/api";
import {
  formatUsd,
  generation,
  isCompiling,
  isLive,
  lastActiveTask,
  latestRun,
} from "../lib/format";
import { deltaTouchesChange, type LiveStatus, useProjectLive } from "../lib/live";

export const Route = createFileRoute("/changes/$changeId")({ component: ChangePage });

/** Safety net while the live socket is down (AGENTS.md section 39). */
const FALLBACK_POLL_MS = 30_000;

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
  const queryClient = useQueryClient();
  const [socket, setSocket] = useState<LiveStatus>("closed");
  // Push replaces polling. The slow poll runs only while the live socket is not open.
  const fallback = socket === "open" ? false : FALLBACK_POLL_MS;
  const change = useQuery({
    queryKey: ["change", changeId],
    queryFn: () => getChange({ data: changeId }),
    refetchInterval: (query) => (isLive(query.state.data, undefined) ? fallback : false),
    // A demo screen may sit in a background tab; polling still stops once the Change is idle.
    refetchIntervalInBackground: true,
  });
  const tasks = useQuery({
    queryKey: ["tasks", changeId],
    queryFn: () => listTasks({ data: changeId }),
    refetchInterval: (query) => (isLive(change.data, query.state.data) ? fallback : false),
    refetchIntervalInBackground: true,
  });
  const conflicts = useQuery({
    queryKey: ["conflicts", changeId],
    queryFn: () => getConflicts({ data: changeId }),
    refetchInterval: () => (isLive(change.data, tasks.data) ? fallback : false),
    refetchIntervalInBackground: true,
  });
  const candidates = useQuery({
    queryKey: ["candidates", changeId],
    queryFn: () => listCandidates({ data: changeId }),
    // Verification runs after the Change settles, so this polls while any Candidate is in flight.
    refetchInterval: (query) =>
      query.state.data?.some((c) => ["composing", "composed", "verifying"].includes(c.status))
        ? FALLBACK_POLL_MS
        : false,
    refetchIntervalInBackground: true,
  });

  const projectId = change.data?.projectId;
  const status = useProjectLive(projectId, isLive(change.data, tasks.data), (signal) => {
    const taskIds = new Set((tasks.data ?? []).map((t) => t.id));
    if (signal.kind === "delta" && !deltaTouchesChange(signal.delta, changeId, taskIds)) return;
    void queryClient.invalidateQueries({ queryKey: ["change", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["tasks", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["conflicts", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["candidates", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["changes", projectId] });
  });
  useEffect(() => setSocket(status), [status]);

  if (change.isError) return <Text variant="secondary">{change.error.message}</Text>;
  if (!change.data) return <Text variant="secondary">Loading Change…</Text>;

  const data = change.data;
  const taskList = tasks.data ?? [];
  const completed = taskList.filter((t) => t.status === "completed").length;
  const live = isLive(data, tasks.data) && socket === "open";
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

      {conflicts.data?.map((conflict) => (
        <ConflictCard key={conflict.id} conflict={conflict} />
      ))}

      <CandidateList
        changeId={changeId}
        candidates={candidates.data ?? []}
        canCompose={!["cancelled", "failed", "completed"].includes(data.status)}
      />

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
