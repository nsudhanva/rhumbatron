import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type CandidateDetail,
  type ChangeDetail,
  type ChangeMeta,
  type EvidenceRecord,
  getChange,
  getChangeClaims,
  getChangeDecisions,
  getChangeProgress,
  getConflicts,
  getWorkspace,
  listCandidateEvidence,
  listCandidates,
  listTasks,
} from "../../lib/api";
import { isLive } from "../../lib/format";
import { deltaTouchesChange, type LiveStatus, useProjectLive } from "../../lib/live";
import { renderNow } from "../../lib/render-time";
import { CHANGE_FEED_INITIAL } from "../change/preload-change";
import { useEventFeed } from "../project/use-event-feed";
import { deriveFlight, type FlightModel } from "./flight-model";

/**
 * Every record Flight Control folds, read with the same React Query keys as the Change page
 * (routes/changes.$changeId.tsx), so the two pages share one cache. Live push invalidates; the
 * slow fallback poll runs only while the Change is live and the socket is not open (AGENTS.md 39).
 * Two more reads than the Change page: the project Workspace (forks, ChangeSets, changed files)
 * and the Change's Decision Receipts.
 */

/** Safety net while the live socket is down (AGENTS.md section 39). */
const FALLBACK_POLL_MS = 30_000;
/** Model calls emit no event: live run progress is polled only while a run is running. */
const PROGRESS_POLL_MS = 5_000;
const IN_FLIGHT = new Set<CandidateDetail["status"]>(["composing", "composed", "verifying"]);

/** Module-level so useQueries keeps the combined result stable between renders. */
function combineEvidence(results: { data: EvidenceRecord[] | undefined; isPending: boolean }[]) {
  return { data: results.map((r) => r.data), pending: results.some((r) => r.isPending) };
}

/** Wall clock that ticks once per second only while `enabled`; otherwise fixed. */
function useNow(enabled: boolean) {
  // The request instant while hydrating (lib/render-time.ts), so elapsed text matches the server.
  const [now, setNow] = useState(renderNow);
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

type FlightData = {
  model: FlightModel | null;
  /** Every source has answered once (or failed). */
  ready: boolean;
  socket: LiveStatus;
  error: string | null;
  projectId: string | undefined;
};

export function useFlightData(changeId: string): FlightData {
  const queryClient = useQueryClient();
  const [socket, setSocket] = useState<LiveStatus>("closed");
  const fallback = socket === "open" ? false : FALLBACK_POLL_MS;

  const change = useQuery({
    queryKey: ["change", changeId],
    queryFn: () => getChange({ data: changeId }) as Promise<ChangeDetail & Partial<ChangeMeta>>,
    refetchInterval: (query) => (isLive(query.state.data, undefined) ? fallback : false),
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
    refetchInterval: (query) =>
      query.state.data?.some((c) => IN_FLIGHT.has(c.status)) ? FALLBACK_POLL_MS : false,
    refetchIntervalInBackground: true,
  });
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

  const projectId = change.data?.projectId;
  const workspace = useQuery({
    queryKey: ["workspace", projectId],
    queryFn: () => getWorkspace({ data: projectId ?? "" }),
    enabled: !!projectId,
  });
  const decisions = useQuery({
    queryKey: ["change-decisions", changeId],
    queryFn: () => getChangeDecisions({ data: changeId }),
  });

  const feed = useEventFeed(
    { kind: "change", changeId },
    { initial: CHANGE_FEED_INITIAL, keep: 1000 },
  );
  // A new claim event in the feed refreshes the Claims read (it holds the full Claim history).
  const lastClaimSeq = useRef(0);
  useEffect(() => {
    const newest = feed.events.find((e) => e.eventType.startsWith("claim."));
    if (!newest || newest.seq <= lastClaimSeq.current) return;
    const first = lastClaimSeq.current === 0;
    lastClaimSeq.current = newest.seq;
    if (!first) void queryClient.invalidateQueries({ queryKey: ["change-claims", changeId] });
  }, [feed.events, changeId, queryClient]);

  const live =
    isLive(change.data, tasks.data) || (candidates.data ?? []).some((c) => IN_FLIGHT.has(c.status));
  const status = useProjectLive(projectId, live, (signal) => {
    feed.refresh();
    // Decision Receipts and forks belong to Tasks; any push can carry one.
    void queryClient.invalidateQueries({ queryKey: ["change-decisions", changeId] });
    void queryClient.invalidateQueries({ queryKey: ["workspace", projectId] });
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

  const evidenceById = useMemo(() => {
    const map: Record<string, EvidenceRecord[] | undefined> = {};
    (candidates.data ?? []).forEach((c, i) => {
      map[c.id] = evidence.data[i];
    });
    return map;
  }, [candidates.data, evidence.data]);

  // The live instant advances once per second only while the Change is live.
  const now = useNow(live);
  const model = useMemo(
    () =>
      change.data
        ? deriveFlight({
            change: change.data,
            tasks: tasks.data ?? [],
            conflicts: conflicts.data ?? [],
            candidates: candidates.data ?? [],
            evidence: evidenceById,
            progress: progress.data ?? [],
            claims: claims.data?.facts ?? [],
            feed: feed.events,
            workspace: workspace.data ?? null,
            decisions: decisions.data?.receipts ?? null,
            now,
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
      workspace.data,
      decisions.data,
      now,
    ],
  );

  const ready =
    !tasks.isPending &&
    !conflicts.isPending &&
    !candidates.isPending &&
    !evidence.pending &&
    !claims.isPending &&
    !workspace.isPending &&
    !decisions.isPending &&
    !feed.loading;

  return {
    model,
    ready,
    socket,
    error: change.isError ? change.error.message : null,
    projectId,
  };
}
