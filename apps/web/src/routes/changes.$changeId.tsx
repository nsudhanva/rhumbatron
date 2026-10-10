import { Show } from "@clerk/tanstack-react-start";
import { Button, buttonVariants, Tabs } from "@cloudflare/kumo";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ApprovalDialog } from "../components/candidate/approval-dialog";
import { candidateLabels, checkRows, gateRule } from "../components/candidate/model";
import { ChangeHeader, OpenAppLink } from "../components/change/change-header";
import { changeSpend } from "../components/change/change-overview";
import { ChecksTab } from "../components/change/checks-tab";
import { FilesTab } from "../components/change/files-tab";
import {
  changeHeadline,
  pickVersion,
  type StepId,
  type VersionView,
} from "../components/change/headline";
import { changeFileView } from "../components/change/model";
import { ProgressTab } from "../components/change/progress-tab";
import { useChangeActions } from "../components/change/use-change-actions";
import { DeadLetters } from "../components/dead-letters";
import { ActivityFeed } from "../components/project/event-stream";
import { useEventFeed } from "../components/project/use-event-feed";
import { EmptyState } from "../components/ui/empty-state";
import { Loader } from "../components/ui/loader";
import { Page } from "../components/ui/page";
import {
  type CandidateDetail,
  type ChangeDetail,
  type ChangeMeta,
  type EvidenceRecord,
  getChange,
  getChangeProgress,
  getConflicts,
  getWorkspace,
  listCandidateEvidence,
  listCandidates,
  listTasks,
} from "../lib/api";
import { isLive } from "../lib/format";
import { deltaTouchesChange, type LiveStatus, useProjectLive } from "../lib/live";

type Tab = "progress" | "files" | "checks" | "activity";
const TABS = new Set<Tab>(["progress", "files", "checks", "activity"]);

export const Route = createFileRoute("/changes/$changeId")({
  // `?tab=` deep-links a tab; Progress is the default and needs no parameter.
  validateSearch: (search: Record<string, unknown>): { tab?: Exclude<Tab, "progress"> } =>
    typeof search.tab === "string" && TABS.has(search.tab as Tab) && search.tab !== "progress"
      ? { tab: search.tab as Exclude<Tab, "progress"> }
      : {},
  component: ChangePage,
});

/** Safety net while the live socket is down (AGENTS.md section 39). */
const FALLBACK_POLL_MS = 30_000;
/**
 * Model calls emit no event, so live run progress is polled, and only while a run is running and
 * the tab is visible. One indexed D1 read of the Change's running attempts per poll.
 */
const PROGRESS_POLL_MS = 5_000;
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
          <EmptyState what="Sign in to view this change." />
        </Page>
      </Show>
    </>
  );
}

function ChangeView() {
  const { changeId } = Route.useParams();
  const { tab = "progress" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const [socket, setSocket] = useState<LiveStatus>("closed");
  const [focusStep, setFocusStep] = useState<{ id: StepId; n: number } | null>(null);
  // Push replaces polling. The slow poll runs only while the live socket is not open.
  const fallback = socket === "open" ? false : FALLBACK_POLL_MS;
  const change = useQuery({
    queryKey: ["change", changeId],
    // The API returns the risk tier and record times with the detail (workers/api changes.ts).
    queryFn: () => getChange({ data: changeId }) as Promise<ChangeDetail & Partial<ChangeMeta>>,
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
    // Verification and release run after the Change settles: poll while a version is in flight.
    refetchInterval: (query) =>
      query.state.data?.some(
        (c) =>
          IN_FLIGHT.has(c.status) ||
          c.release?.status === "queued" ||
          c.release?.status === "building",
      )
        ? FALLBACK_POLL_MS
        : false,
    refetchIntervalInBackground: true,
  });
  // Same key as the version page, so both pages share one read per version.
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
  const projectId = change.data?.projectId;
  // File counts per task and per version come from the project's recorded code changes.
  const workspace = useQuery({
    queryKey: ["workspace", projectId],
    queryFn: () => getWorkspace({ data: projectId ?? "" }),
    enabled: !!projectId,
  });
  // Recorded events of this Change: read once, then only newer rows on each push.
  const feed = useEventFeed({ kind: "change", changeId }, { initial: 100, keep: 500 });

  const live = isLive(change.data, tasks.data);
  const status = useProjectLive(projectId, live, (signal) => {
    feed.refresh();
    const taskIds = new Set((tasks.data ?? []).map((t) => t.id));
    if (signal.kind === "delta" && !deltaTouchesChange(signal.delta, changeId, taskIds)) return;
    void queryClient.invalidateQueries({ queryKey: ["change", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["tasks", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["conflicts", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["candidates", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["change-progress", changeId] });
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
  // A finished task or a new version can add code changes: re-read file counts only then.
  const doneCount = (tasks.data ?? []).filter((t) => t.status === "completed").length;
  const versionCount = candidates.data?.length ?? 0;
  useEffect(() => {
    if (!projectId || doneCount + versionCount === 0) return;
    void queryClient.invalidateQueries({ queryKey: ["workspace", projectId] });
  }, [doneCount, versionCount, projectId, queryClient]);

  const actions = useChangeActions({
    changeId,
    projectId,
    goal: change.data?.goal,
    budgetUsd: change.data?.budgetUsd,
  });

  const versions = useMemo<VersionView[]>(() => {
    const list = candidates.data ?? [];
    const labels = candidateLabels(list);
    return [...list]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map((candidate, i) => ({
        candidate,
        rows: checkRows(candidate, evidence.data[list.indexOf(candidate)] ?? []),
        label: labels.get(candidate.id) ?? `Version ${String.fromCharCode(65 + i)}`,
      }));
  }, [candidates.data, evidence.data]);

  if (change.isError) {
    return (
      <Page>
        <p className="rounded-md bg-kumo-danger-tint px-3 py-2 text-[14px] text-kumo-danger">
          {change.error.message}
        </p>
      </Page>
    );
  }
  if (!change.data) {
    return (
      <Page>
        <p className="flex items-center gap-2 text-[14px]">
          <Loader /> Loading the change
        </p>
      </Page>
    );
  }

  const data = change.data;
  const taskList = tasks.data ?? [];
  const spend = changeSpend(taskList);
  const now = Date.now();
  const files = changeFileView(workspace.data, taskList, pickVersion(versions)?.candidate ?? null);
  const headline = changeHeadline({
    status: data.status,
    riskTier: data.riskTier,
    baseGeneration: data.baseGeneration,
    budgetUsd: data.budgetUsd,
    spentUsd: spend?.costUsd ?? 0,
    updatedAt: data.updatedAt,
    tasks: taskList,
    conflicts: conflicts.data ?? [],
    versions,
    filesChanged: files.summary ? files.summary.files.length : null,
    now,
  });
  const version = headline.version;

  const shipVersion = () => {
    if (version) actions.ship.mutate(version.candidate.id);
  };
  const seeFailed = () => {
    if (!headline.failedStep) return;
    void navigate({ search: {}, replace: true });
    setFocusStep((f) => ({ id: headline.failedStep ?? "agents", n: (f?.n ?? 0) + 1 }));
  };
  const primaryKind = headline.primary?.kind;
  const primary = (() => {
    if (!headline.primary) return null;
    const label = headline.primary.label;
    switch (primaryKind) {
      case "run-checks":
        return (
          <Button
            variant="primary"
            loading={actions.runChecks.isPending}
            onClick={() => actions.runChecks.mutate()}
          >
            {label}
          </Button>
        );
      case "review-approve":
        return (
          <Button
            variant="primary"
            loading={actions.ship.isPending}
            onClick={() => actions.setApprovalOpen(true)}
          >
            {label}
          </Button>
        );
      case "ship":
        return (
          <Button variant="primary" loading={actions.ship.isPending} onClick={shipVersion}>
            {label}
          </Button>
        );
      case "open-app":
        return version?.candidate.release?.url ? (
          <OpenAppLink url={version.candidate.release.url} />
        ) : null;
      case "view-release":
        return version ? (
          <Link
            to="/candidates/$candidateId"
            params={{ candidateId: version.candidate.id }}
            className={buttonVariants({ variant: "primary" })}
          >
            {label}
          </Link>
        ) : null;
      case "see-failed":
        return (
          <Button variant="primary" onClick={seeFailed}>
            {label}
          </Button>
        );
      default:
        return (
          <Button
            variant="primary"
            loading={actions.restart.isPending}
            onClick={() => actions.restart.mutate(primaryKind === "restart-larger" ? 2 : 1)}
          >
            {label}
          </Button>
        );
    }
  })();

  const checkCount = version?.rows.length ?? 0;
  const tabs = [
    { value: "progress", label: "Progress" },
    { value: "files", label: files.count > 0 ? `Files changed (${files.count})` : "Files changed" },
    { value: "checks", label: checkCount > 0 ? `Checks (${checkCount})` : "Checks" },
    { value: "activity", label: "Activity" },
  ];

  return (
    <Page gap="tight">
      <DeadLetters projectId={data.projectId} changeId={data.id} />

      <ChangeHeader
        changeId={changeId}
        goal={data.goal}
        headline={headline}
        createdAt={data.createdAt}
        spentUsd={spend?.costUsd ?? null}
        budgetUsd={data.budgetUsd}
        baseGeneration={data.baseGeneration}
        riskTier={data.riskTier}
        live={live && socket === "open"}
        versionCount={versions.length}
        primary={primary}
      />
      {actions.restart.isError && (
        <p role="alert" className="text-[13px] text-kumo-danger">
          Could not start again: {actions.restart.error.message}
        </p>
      )}

      <div className="grid gap-5">
        <Tabs
          variant="underline"
          tabs={tabs}
          value={tab}
          onValueChange={(next) =>
            void navigate({
              search: next === "progress" ? {} : { tab: next as Exclude<Tab, "progress"> },
              replace: true,
            })
          }
        />
        {tab === "progress" && (
          <ProgressTab
            change={data}
            riskTier={data.riskTier}
            headline={headline}
            tasks={taskList}
            conflicts={conflicts.data ?? []}
            versions={versions}
            progress={progress.data ?? []}
            workspace={workspace.data}
            feed={feed.events}
            files={files}
            spentUsd={spend?.costUsd ?? null}
            run={{
              start: () => actions.runChecks.mutate(),
              pending: actions.runChecks.isPending,
              error: actions.runChecks.error?.message ?? null,
            }}
            ship={{
              pending: actions.ship.isPending,
              error: actions.ship.error?.message ?? null,
              outcome: actions.ship.data,
              retry: shipVersion,
            }}
            onReview={() => actions.setApprovalOpen(true)}
            focusStep={focusStep}
            now={now}
          />
        )}
        {tab === "files" && <FilesTab files={files} versionLabel={version?.label ?? null} />}
        {tab === "checks" && <ChecksTab versions={versions} />}
        {tab === "activity" && (
          <ActivityFeed
            events={feed.events}
            loading={feed.loading}
            error={feed.error}
            onRetry={feed.refresh}
          />
        )}
      </div>

      {version?.candidate.approvalRequired && !version.candidate.approval && (
        <ApprovalDialog
          open={actions.approvalOpen}
          onOpenChange={actions.setApprovalOpen}
          candidate={version.candidate}
          label={version.label}
          rows={version.rows}
          rule={gateRule(version.candidate, data.riskTier)}
          onDecided={(decision) => {
            void actions.refresh();
            // "Approve and ship" is one action for the user: approval, then promotion.
            if (decision === "approve") actions.ship.mutate(version.candidate.id);
          }}
        />
      )}
    </Page>
  );
}
