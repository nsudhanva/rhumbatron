import { Show } from "@clerk/tanstack-react-start";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { deriveActivity } from "../components/agents/activity-model";
import { AgentActivity } from "../components/agents/agent-activity";
import { CandidateList } from "../components/candidate-list";
import {
  ChangeStats,
  CriteriaList,
  changeSpend,
  InvariantList,
} from "../components/change/change-overview";
import { ConflictCard } from "../components/conflict-card";
import { TaskPanel } from "../components/task-detail";
import { EmptyState } from "../components/ui/empty-state";
import { Loader } from "../components/ui/loader";
import { Mono } from "../components/ui/mono";
import { Page, PageTitle, Section, TwoUp } from "../components/ui/page";
import { StatusPill } from "../components/ui/status-pill";
import { Tag } from "../components/ui/tag";
import { WorkGraph } from "../components/work-graph";
import {
  type CandidateDetail,
  type EvidenceRecord,
  getChange,
  getConflicts,
  listCandidateEvidence,
  listCandidates,
  listChanges,
  listTasks,
} from "../lib/api";
import {
  formatFraction,
  formatNumber,
  formatUsd,
  generation,
  isCompiling,
  isLive,
  lastActiveTask,
  timeAgo,
} from "../lib/format";
import { deltaTouchesChange, type LiveStatus, useProjectLive } from "../lib/live";

export const Route = createFileRoute("/changes/$changeId")({ component: ChangePage });

/** Safety net while the live socket is down (AGENTS.md section 39). */
const FALLBACK_POLL_MS = 30_000;
const IN_FLIGHT = new Set<CandidateDetail["status"]>(["composing", "composed", "verifying"]);

/** Module-level so useQueries keeps the combined result stable between renders. */
function combineEvidence(results: { data: EvidenceRecord[] | undefined; isPending: boolean }[]) {
  return { data: results.map((r) => r.data), pending: results.some((r) => r.isPending) };
}

function ChangePage() {
  return (
    <>
      <Show when="signed-in">
        <ChangeView />
      </Show>
      <Show when="signed-out">
        <Page>
          <EmptyState what="Sign in to view this Change." />
        </Page>
      </Show>
    </>
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
      query.state.data?.some((c) => IN_FLIGHT.has(c.status)) ? FALLBACK_POLL_MS : false,
    refetchIntervalInBackground: true,
  });
  // Evidence drives the check segments in the activity view. Same key as the Candidate page.
  const evidence = useQueries({
    queries: (candidates.data ?? []).map((c) => ({
      queryKey: ["candidate-evidence", c.id],
      queryFn: () => listCandidateEvidence({ data: c.id }),
      refetchInterval: IN_FLIGHT.has(c.status) ? FALLBACK_POLL_MS : (false as const),
    })),
    combine: combineEvidence,
  });

  const projectId = change.data?.projectId;
  // Risk tier and creation time live on the Change summary, not on the detail.
  const summaries = useQuery({
    queryKey: ["changes", projectId],
    queryFn: () => listChanges({ data: projectId ?? "" }),
    enabled: !!projectId,
  });
  const status = useProjectLive(projectId, isLive(change.data, tasks.data), (signal) => {
    const taskIds = new Set((tasks.data ?? []).map((t) => t.id));
    if (signal.kind === "delta" && !deltaTouchesChange(signal.delta, changeId, taskIds)) return;
    void queryClient.invalidateQueries({ queryKey: ["change", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["tasks", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["conflicts", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["candidates", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["changes", projectId] });
    for (const c of candidates.data ?? []) {
      void queryClient.invalidateQueries({ queryKey: ["candidate-evidence", c.id] });
    }
  });
  useEffect(() => setSocket(status), [status]);

  const evidenceById = useMemo(() => {
    const map: Record<string, EvidenceRecord[] | undefined> = {};
    (candidates.data ?? []).forEach((c, i) => {
      map[c.id] = evidence.data[i];
    });
    return map;
  }, [candidates.data, evidence.data]);

  const model = useMemo(
    () =>
      change.data
        ? deriveActivity({
            change: change.data,
            tasks: tasks.data ?? [],
            conflicts: conflicts.data ?? [],
            candidates: candidates.data ?? [],
            evidence: evidenceById,
          })
        : null,
    [change.data, tasks.data, conflicts.data, candidates.data, evidenceById],
  );
  // Every source has answered once (or failed): later facts are new and animate.
  const ready =
    !tasks.isPending && !conflicts.isPending && !candidates.isPending && !evidence.pending;

  if (change.isError) {
    return (
      <Page>
        <p className="bg-accent-100 px-3 py-2 text-[13px] font-semibold text-kumo-danger">
          {change.error.message}
        </p>
      </Page>
    );
  }
  if (!change.data || !model) {
    return (
      <Page>
        <p className="flex items-center gap-2 text-[13px]">
          <Loader /> Loading Change
        </p>
      </Page>
    );
  }

  const data = change.data;
  const summary = summaries.data?.find((c) => c.id === changeId);
  const taskList = tasks.data ?? [];
  const conflictList = conflicts.data ?? [];
  const candidateList = candidates.data ?? [];
  const live = isLive(data, tasks.data) && socket === "open";
  const selectedTask = taskList.find((t) => t.id === selected) ?? lastActiveTask(taskList);
  const spend = changeSpend(taskList);
  const compiling = isCompiling(data.status) && taskList.length === 0;

  return (
    <Page>
      <PageTitle
        size="detail"
        kicker={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>Change</span>
            <StatusPill status={data.status} className="tracking-normal normal-case" />
            {summary?.riskTier && (
              <Tag variant="outline" className="tracking-normal normal-case">
                Risk {summary.riskTier}
              </Tag>
            )}
          </span>
        }
        title={data.goal}
        meta={
          <>
            <span>
              Base <Mono>{generation(data.baseGeneration)}</Mono>
            </span>
            <span aria-hidden>·</span>
            <span>
              Budget{" "}
              <Mono>
                {spend
                  ? formatFraction(formatUsd(spend.costUsd), formatUsd(data.budgetUsd))
                  : formatUsd(data.budgetUsd)}
              </Mono>
            </span>
            {summary && (
              <>
                <span aria-hidden>·</span>
                <span>created {timeAgo(summary.createdAt)}</span>
              </>
            )}
            <span aria-hidden>·</span>
            <Mono subtle>{data.id}</Mono>
            {live && <StatusPill status="live" />}
          </>
        }
      />

      <ChangeStats
        tasks={taskList}
        conflicts={conflictList}
        candidates={candidateList}
        budgetUsd={data.budgetUsd}
      />

      <AgentActivity model={model} ready={ready} compiling={compiling} />

      <TwoUp>
        <Section
          label="Acceptance criteria"
          meta={<Mono subtle>{formatNumber(data.acceptanceCriteria.length)}</Mono>}
        >
          <CriteriaList items={data.acceptanceCriteria} />
        </Section>
        <Section
          label="Protected invariants"
          meta={<Mono subtle>{formatNumber(data.invariants.length)}</Mono>}
        >
          <InvariantList items={data.invariants} />
        </Section>
      </TwoUp>

      {conflictList.length > 0 && (
        <Section
          label="Conflicts"
          meta={
            <Mono subtle>
              {formatNumber(conflictList.filter((c) => c.state !== "resolved").length)} open
            </Mono>
          }
        >
          <div className="grid gap-4">
            {conflictList.map((conflict) => (
              <ConflictCard key={conflict.id} conflict={conflict} />
            ))}
          </div>
        </Section>
      )}

      <CandidateList
        changeId={changeId}
        candidates={candidateList}
        canCompose={!["cancelled", "failed", "completed"].includes(data.status)}
      />

      <div className="grid gap-7 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
        <Section
          label="Work graph"
          meta={<Mono subtle>{formatNumber(taskList.length)} Tasks</Mono>}
        >
          {compiling ? (
            <p className="flex items-center gap-2 text-[13px]">
              <Loader /> Root Planner is compiling the Work Graph.
            </p>
          ) : taskList.length === 0 ? (
            <EmptyState what="No Tasks." how="This Change has no Work Graph." />
          ) : (
            <WorkGraph tasks={taskList} selectedId={selectedTask?.id} onSelect={setSelected} />
          )}
        </Section>
        <Section label="Task details">
          <div className="bg-kumo-elevated p-4 shadow-[inset_2px_0_0_var(--color-accent-500)]">
            <TaskPanel task={selectedTask} />
          </div>
        </Section>
      </div>
    </Page>
  );
}
