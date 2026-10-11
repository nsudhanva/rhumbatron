import { Show } from "@clerk/tanstack-react-start";
import { buttonVariants, cn } from "@cloudflare/kumo";
import { Airplane, ArrowSquareOut, CheckCircle, RocketLaunch } from "@phosphor-icons/react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { deriveActivity } from "../components/agents/activity-model";
import { AgentActivity } from "../components/agents/agent-activity";
import { candidateLabels } from "../components/candidate/model";
import { CandidateSummary } from "../components/change/candidate-summary";
import { CancelChange } from "../components/change/change-controls";
import { ChangeHeader } from "../components/change/change-header";
import { ChangeStats, changeSpend, InvariantList } from "../components/change/change-overview";
import { statusLine } from "../components/change/change-status";
import { ConflictList } from "../components/change/conflict-list";
import { Disclosure } from "../components/change/disclosure";
import { awaitingApproval, NeedsAttention } from "../components/change/needs-attention";
import { ChangeFilesChanged } from "../components/code/files-changed";
import { useEventFeed } from "../components/project/use-event-feed";
import { TaskPanel } from "../components/task-detail";
import { EmptyState } from "../components/ui/empty-state";
import { KeyValue } from "../components/ui/key-value";
import { Loader } from "../components/ui/loader";
import { Mono } from "../components/ui/mono";
import { Page, Section } from "../components/ui/page";
import { WorkGraph } from "../components/work-graph";
import {
  type ChangeOutcome,
  type EvidenceRecord,
  getChange,
  getChangeClaims,
  getChangeProgress,
  getConflicts,
  getDeadLetters,
  getProject,
  getProjectApp,
  getRequestConflicts,
  listCandidateEvidence,
  listCandidates,
  listChangeSets,
  listTasks,
} from "../lib/api";
import type { CandidateView, ChangeView as ChangeRead } from "../lib/api-change";
import {
  formatFraction,
  formatNumber,
  formatUsd,
  generation,
  isCompiling,
  isLive,
  lastActiveTask,
} from "../lib/format";
import { deltaTouchesChange, type LiveStatus, useProjectLive } from "../lib/live";

export const Route = createFileRoute("/changes/$changeId")({ component: ChangePage });

/** Safety net while the live socket is down (AGENTS.md section 39). */
const FALLBACK_POLL_MS = 30_000;
/**
 * Model calls emit no event, so live run progress is polled, and only while a run is running and
 * the tab is visible. One indexed D1 read of the Change's running attempts per poll.
 */
const PROGRESS_POLL_MS = 5_000;
const IN_FLIGHT = new Set<CandidateView["status"]>(["composing", "composed", "verifying"]);

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
    // The API returns the risk tier and record times with the detail (workers/api changes.ts).
    queryFn: () => getChange({ data: changeId }) as Promise<ChangeRead>,
    // A Change waiting for an answer has no live work, but the answer can come from another
    // person, so it keeps the slow poll.
    refetchInterval: (query) =>
      isLive(query.state.data, undefined) || query.state.data?.status === "needs_input"
        ? fallback
        : false,
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
  const requestConflicts = useQuery({
    queryKey: ["request-conflicts", changeId],
    queryFn: () => getRequestConflicts({ data: changeId }),
    refetchInterval: () => (isLive(change.data, tasks.data) ? fallback : false),
    refetchIntervalInBackground: true,
  });
  const candidates = useQuery({
    queryKey: ["candidates", changeId],
    queryFn: () => listCandidates({ data: changeId }) as Promise<CandidateView[]>,
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

  const running = (tasks.data ?? []).some((t) => t.runs.at(-1)?.status === "running");
  const progress = useQuery({
    queryKey: ["change-progress", changeId],
    queryFn: () => getChangeProgress({ data: changeId }),
    enabled: running,
    refetchInterval: running ? PROGRESS_POLL_MS : false,
  });
  const claims = useQuery({
    queryKey: ["change-claims", changeId],
    queryFn: () => getChangeClaims({ data: changeId }),
  });
  // Recorded events of this Change: read once, then only newer rows on each push.
  const feed = useEventFeed({ kind: "change", changeId }, { initial: 100, keep: 500 });
  // A new claim event in the feed refreshes the Claims read (it holds the full Claim history).
  const lastClaimSeq = useRef(0);
  useEffect(() => {
    const newest = feed.events.find((e) => e.eventType.startsWith("claim."));
    if (!newest || newest.seq <= lastClaimSeq.current) return;
    const first = lastClaimSeq.current === 0;
    lastClaimSeq.current = newest.seq;
    if (!first) void queryClient.invalidateQueries({ queryKey: ["change-claims", changeId] });
  }, [feed.events, changeId, queryClient]);

  const projectId = change.data?.projectId;
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: projectId ?? "" }),
    enabled: !!projectId,
  });
  const isOwner = project.data?.role === "owner";
  // The live app answers "Live as Sn" and the "Open live app" action, once the Change ships.
  const shipped = ["releasing", "completed"].includes(change.data?.status ?? "");
  const projectApp = useQuery({
    queryKey: ["project-app", projectId],
    queryFn: () => getProjectApp({ data: projectId ?? "" }),
    enabled: !!projectId && shipped,
  });
  // Same key and read as the DeadLetters block, so "Needs attention" knows whether it has rows.
  const operator = useQuery({
    queryKey: ["dead-letters", projectId, changeId],
    queryFn: () => getDeadLetters({ data: { projectId: projectId ?? "", changeId } }),
    enabled: !!projectId,
    refetchInterval: 60_000,
  });
  // Same key as Files changed; the Task inspector lists the files of the selected Task.
  const changeSets = useQuery({
    queryKey: ["changesets", changeId],
    queryFn: () => listChangeSets({ data: changeId }),
  });
  const live = isLive(change.data, tasks.data);
  const status = useProjectLive(projectId, live, (signal) => {
    // Any push can carry events of this Change (claims, routes), so the feed always reads on.
    feed.refresh();
    const taskIds = new Set((tasks.data ?? []).map((t) => t.id));
    if (signal.kind === "delta" && !deltaTouchesChange(signal.delta, changeId, taskIds)) return;
    void queryClient.invalidateQueries({ queryKey: ["change", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["tasks", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["conflicts", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["request-conflicts", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["candidates", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["change-progress", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["changesets", changeId] });
    for (const c of candidates.data ?? []) {
      void queryClient.invalidateQueries({ queryKey: ["candidate-evidence", c.id] });
    }
  });
  useEffect(() => setSocket(status), [status]);
  // Without the socket, the feed follows the same slow fallback poll as the other reads.
  const refreshFeed = feed.refresh;
  useEffect(() => {
    if (!live || status === "open") return;
    const timer = setInterval(refreshFeed, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [live, status, refreshFeed]);

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
            progress: progress.data ?? [],
            claims: claims.data?.facts ?? [],
            feed: feed.events,
          })
        : null,
    [
      change.data,
      tasks.data,
      conflicts.data,
      candidates.data,
      evidenceById,
      progress.data,
      claims.data,
      feed.events,
    ],
  );
  // Every source has answered once (or failed): later facts are new and animate.
  const ready =
    !tasks.isPending &&
    !conflicts.isPending &&
    !requestConflicts.isPending &&
    !candidates.isPending &&
    !evidence.pending &&
    !claims.isPending &&
    !feed.loading;

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
  const taskList = tasks.data ?? [];
  const conflictList = conflicts.data ?? [];
  const requestConflictList = requestConflicts.data ?? [];
  const candidateList = candidates.data ?? [];
  const liveOpen = live && socket === "open";
  const selectedTask = taskList.find((t) => t.id === selected) ?? lastActiveTask(taskList);
  const spend = changeSpend(taskList);
  const compiling = isCompiling(data.status) && taskList.length === 0;
  const canAnswer = data.requester?.isYou === true || isOwner;
  const names = candidateLabels(candidateList);
  const liveApp = projectApp.data?.app?.status === "ready" ? projectApp.data.app : null;
  const line = statusLine({
    change: data,
    tasks: taskList,
    candidates: candidateList,
    canAnswer,
    liveGeneration: liveApp?.generation ?? null,
  });
  const approval = awaitingApproval(candidateList);
  const promotable = candidateList.find(
    (c) =>
      c.status === "verified" &&
      c.gate?.promotable === true &&
      (!c.approvalRequired || c.approval?.decision === "granted"),
  );
  const operatorIssues =
    (operator.data?.deadLetters.length ?? 0) + (operator.data?.limits.length ?? 0) > 0;
  const taskChangeSets = (changeSets.data ?? []).filter((s) => s.taskId === selectedTask?.id);
  const taskClaims = (claims.data?.claims ?? []).filter(
    (c) => selectedTask?.assignedAgentId && c.agentId === selectedTask.assignedAgentId,
  );

  // One primary action at most (DESIGN.md 8.1). Answering happens in the form below the title.
  const primary =
    data.status === "needs_input" ? null : approval ? (
      <Link
        to="/candidates/$candidateId"
        params={{ candidateId: approval.id }}
        className={cn(buttonVariants({ variant: "primary" }), "gap-1.5")}
      >
        <CheckCircle size={16} aria-hidden />
        Review and approve
      </Link>
    ) : promotable && !["promoting", "releasing", "completed"].includes(data.status) ? (
      <Link
        to="/candidates/$candidateId"
        params={{ candidateId: promotable.id }}
        className={cn(buttonVariants({ variant: "primary" }), "gap-1.5")}
      >
        <RocketLaunch size={16} aria-hidden />
        Review and promote
      </Link>
    ) : data.status === "completed" && liveApp ? (
      <a
        href={liveApp.url}
        target="_blank"
        rel="noreferrer"
        className={cn(buttonVariants({ variant: "primary" }), "gap-1.5")}
      >
        <ArrowSquareOut size={16} aria-hidden />
        Open live app
      </a>
    ) : null;

  return (
    <Page>
      <ChangeHeader
        change={data}
        line={line}
        live={liveOpen}
        actions={
          <>
            <CancelChange changeId={data.id} status={data.status} />
            <Link
              to="/changes/$changeId/flight"
              params={{ changeId }}
              className={cn(
                buttonVariants({ variant: primary ? "secondary" : "primary" }),
                "gap-1.5",
              )}
            >
              <Airplane size={16} aria-hidden />
              Open Flight Control
            </Link>
            {primary}
          </>
        }
      />

      <NeedsAttention
        change={data}
        candidates={candidateList}
        conflicts={conflictList}
        candidateLabel={(id) => names.get(id) ?? id}
        canAnswer={canAnswer}
        hasOperatorIssues={operatorIssues}
      />

      <div className="grid gap-7 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
        <Section
          label="Work graph"
          meta={
            taskList.length > 0 && (
              <Mono subtle>
                {formatNumber(taskList.filter((t) => t.status === "completed").length)} /{" "}
                {formatNumber(taskList.length)} Tasks done
              </Mono>
            )
          }
        >
          {compiling ? (
            <p className="flex items-center gap-2 text-[13px]">
              <Loader /> Root Planner is compiling the Work Graph.
            </p>
          ) : taskList.length === 0 ? (
            <EmptyState
              what="No Tasks."
              how={
                data.status === "needs_input"
                  ? "Tasks appear after the questions above are answered."
                  : "This Change has no Work Graph."
              }
            />
          ) : (
            <WorkGraph tasks={taskList} selectedId={selectedTask?.id} onSelect={setSelected} />
          )}
        </Section>
        <Section label="Task">
          <div
            className={cn(
              "bg-kumo-elevated p-4",
              // The accent bar pairs the inspector with the selected node; none when empty.
              selectedTask && "shadow-[inset_2px_0_0_var(--color-accent-500)]",
            )}
          >
            <TaskPanel task={selectedTask} changeSets={taskChangeSets} claims={taskClaims} />
          </div>
        </Section>
      </div>

      <AgentActivity model={model} ready={ready} compiling={compiling} />

      <CandidateSummary
        changeId={changeId}
        candidates={candidateList}
        evidence={evidenceById}
        criteria={data.acceptanceCriteria}
        canCompose={
          !["cancelled", "failed", "completed", "promoting", "releasing", "needs_input"].includes(
            data.status,
          )
        }
      />

      <ChangeFilesChanged changeId={changeId} />

      <ConflictList
        changeId={changeId}
        conflicts={conflictList}
        requestConflicts={requestConflictList}
        outcomeReason={data.outcome?.reason}
      />

      <Disclosure label="Details" className="border-t-2 border-kumo-divider pt-1">
        <ChangeStats
          tasks={taskList}
          conflicts={conflictList}
          candidates={candidateList}
          budgetUsd={data.budgetUsd}
        />
        <KeyValue
          items={[
            { label: "Change", value: data.id, mono: true },
            { label: "Project", value: data.projectId, mono: true },
            { label: "Base generation", value: generation(data.baseGeneration), mono: true },
            {
              label: "Budget",
              value: spend
                ? formatFraction(formatUsd(spend.costUsd), formatUsd(data.budgetUsd))
                : formatUsd(data.budgetUsd),
              mono: true,
            },
            { label: "Risk tier", value: data.riskTier ?? null },
            { label: "Status", value: data.status, mono: true },
            { label: "Requester", value: data.requester?.userId ?? null, mono: true },
            { label: "Outcome", value: data.outcome ? outcomeWords(data.outcome) : null },
            { label: "Work Graph", value: data.workGraphRef ?? null, mono: true },
            { label: "Created", value: data.createdAt ?? null, mono: true },
            { label: "Updated", value: data.updatedAt ?? null, mono: true },
          ]}
        />
        <div className="grid gap-1">
          <h3 className="type-label text-kumo-subtle">Protected invariants</h3>
          <InvariantList items={data.invariants} />
        </div>
      </Disclosure>
    </Page>
  );
}

/** The recorded request-conflict outcome in words. */
function outcomeWords(outcome: ChangeOutcome) {
  const kind = outcome.kind.replace(/_/g, " ");
  return outcome.reason ? `${kind}: ${outcome.reason}` : kind;
}
