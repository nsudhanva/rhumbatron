import { useAuth } from "@clerk/tanstack-react-start";
import { useEffect, useRef, useState } from "react";
import { useLiveStatusReporter } from "./live-status";

/**
 * Client for the Project live socket (AGENTS.md section 39): snapshot plus sequence deltas from
 * ProjectViewDO through the same-origin route `/live/projects/:projectId`. The socket carries
 * change signals only. Pages still read their data from the API, so a lost message costs at most
 * one refetch and never shows wrong data.
 */

/**
 * `connecting`: first connect. `reconnecting`: a retry after a failed attempt. A quick reconnect
 * after a normal close (deploy, object eviction, idle timeout) keeps the status at `open`.
 */
export type LiveStatus = "connecting" | "reconnecting" | "open" | "closed";

type ListName =
  | "activeChanges"
  | "activeTasks"
  | "activeAgents"
  | "candidateSummary"
  | "verificationSummary";

type LiveItem = { id: string; status: string; label?: string; changeId?: string };

/** The parts of a ProjectViewDelta that pages use to decide what to refetch. */
export type LiveDelta = {
  upsert?: Partial<Record<ListName, LiveItem[]>>;
  remove?: Partial<Record<ListName, string[]>>;
  canonicalGeneration?: number;
};

/** `snapshot`: state may have changed in an unknown way (first connect, reconnect, gap). */
export type LiveSignal = { kind: "snapshot" } | { kind: "delta"; delta: LiveDelta };

type ServerMessage =
  | { type: "snapshot"; sequence: number }
  | { type: "delta"; sequence: number; changes: LiveDelta };

const PING_MS = 30_000;
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/** Same rule as the coordinator view model: a sequence must advance by exactly one. */
function sequenceGap(lastSeen: number, incoming: number): "ok" | "gap" | "duplicate" {
  if (incoming <= lastSeen) return "duplicate";
  return incoming === lastSeen + 1 ? "ok" : "gap";
}

function parse(data: unknown): ServerMessage | null {
  if (typeof data !== "string" || data === "pong") return null;
  try {
    const message = JSON.parse(data) as Partial<ServerMessage>;
    if (typeof message.sequence !== "number") return null;
    if (message.type === "snapshot" || message.type === "delta") return message as ServerMessage;
  } catch {
    // Not JSON: ignore it.
  }
  return null;
}

/** True when the delta touches this Change, one of its Tasks, or one of its Agents. */
export function deltaTouchesChange(delta: LiveDelta, changeId: string, taskIds: Set<string>) {
  for (const items of Object.values(delta.upsert ?? {})) {
    for (const item of items ?? []) {
      if (item.id === changeId || item.changeId === changeId || taskIds.has(item.id)) return true;
    }
  }
  for (const ids of Object.values(delta.remove ?? {})) {
    for (const id of ids ?? []) if (id === changeId || taskIds.has(id)) return true;
  }
  return false;
}

/**
 * Opens the live socket while `enabled`, reconnects with jittered backoff, and calls `onSignal`
 * for each snapshot or in-order delta. A sequence gap asks the server for a fresh snapshot.
 */
export function useProjectLive(
  projectId: string | undefined,
  enabled: boolean,
  onSignal: (signal: LiveSignal) => void,
): LiveStatus {
  const { getToken } = useAuth();
  const [status, setStatus] = useState<LiveStatus>("closed");
  const signalRef = useRef(onSignal);
  const tokenRef = useRef(getToken);
  useEffect(() => {
    signalRef.current = onSignal;
    tokenRef.current = getToken;
  });

  useEffect(() => {
    if (!projectId || !enabled) {
      setStatus("closed");
      return;
    }
    let socket: WebSocket | undefined;
    let stopped = false;
    let attempt = 0;
    let failures = 0;
    let wasOpen = false;
    let lastSequence = -1;
    let awaitingSnapshot = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;

    const scheduleRetry = () => {
      const base = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** attempt);
      attempt += 1;
      retryTimer = setTimeout(connect, base / 2 + Math.random() * (base / 2));
    };

    const onMessage = (ws: WebSocket, message: ServerMessage) => {
      if (message.type === "snapshot") {
        awaitingSnapshot = false;
        const changed = message.sequence !== lastSequence;
        lastSequence = message.sequence;
        if (changed) signalRef.current({ kind: "snapshot" });
        return;
      }
      if (awaitingSnapshot) return;
      const order = sequenceGap(lastSequence, message.sequence);
      if (order === "duplicate") return;
      if (order === "gap") {
        // Section 39: never patch over a gap. The next snapshot resets the sequence.
        awaitingSnapshot = true;
        ws.send(JSON.stringify({ type: "snapshot.request" }));
        return;
      }
      lastSequence = message.sequence;
      signalRef.current({ kind: "delta", delta: message.changes });
    };

    async function connect() {
      // A first retry right after a socket that was open is silent: the footer must not flash.
      if (failures > 0) setStatus("reconnecting");
      else if (!wasOpen) setStatus("connecting");
      // Refreshes the short-lived Clerk session cookie that the upgrade request carries.
      // The token itself is never put in the socket URL.
      await tokenRef.current().catch(() => null);
      if (stopped) return;
      const url = new URL(`/live/projects/${encodeURIComponent(projectId ?? "")}`, location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      if (lastSequence >= 0) url.searchParams.set("afterSequence", String(lastSequence));

      const ws = new WebSocket(url);
      socket = ws;
      awaitingSnapshot = false;
      let opened = false;
      ws.onopen = () => {
        attempt = 0;
        failures = 0;
        wasOpen = true;
        opened = true;
        setStatus("open");
        // The object answers "ping" without waking from hibernation.
        pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), PING_MS);
      };
      ws.onmessage = (event) => {
        const message = parse(event.data);
        if (message) onMessage(ws, message);
      };
      ws.onclose = () => {
        clearInterval(pingTimer);
        if (socket !== ws || stopped) return;
        socket = undefined;
        if (!opened) {
          failures += 1;
          setStatus("closed");
        }
        opened = false;
        scheduleRetry();
      };
    }

    void connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      socket?.close(1000, "page closed");
    };
  }, [projectId, enabled]);

  // Mirror the socket state into the shell status bar. Leaving the page clears it.
  const report = useLiveStatusReporter();
  const active = !!projectId && enabled;
  useEffect(() => {
    report?.({ status, enabled: active });
  }, [report, status, active]);
  useEffect(() => () => report?.({ status: "idle" }), [report]);

  return status;
}
