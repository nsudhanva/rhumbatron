import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { getNotificationCount } from "../../lib/api";
import { BellButton } from "./bell-button";
import { formatBadge, NOTIFICATION_KEYS, plural } from "./notification-keys";

/**
 * Inbox entry point in the shell header (DESIGN.md 6.1, 8.4, 10). A square bell with a square
 * count badge: accent while an item needs a decision, ink while there are only unread updates
 * (principle 2: the accent marks what needs a decision).
 *
 * Load cost: this module holds only the button, the count read, and the title and live-region
 * hooks. The popover (Kumo/Base UI) and the inbox list are one lazy chunk, fetched when the
 * browser is idle after first paint or on the first hover, focus, or click, whichever is first.
 * Until then the same button renders without the popover, so nothing shifts when it swaps.
 *
 * D1 cost: the button reads only `/v1/notifications/count` (one D1 batch): every 60 s while the
 * tab is visible (React Query pauses intervals in background tabs), on window focus, and shortly
 * after a page's live socket signal. The full list loads only while the popover is open.
 */

const loadPopover = () => import("./notification-popover");
const NotificationPopover = lazy(loadPopover);

/** Count refresh while the tab is visible. */
const POLL_MS = 60_000;
/** A live burst invalidates many page queries at once: refresh the count once, after it settles. */
const SIGNAL_DEBOUNCE_MS = 1_500;
/** At most one signal-driven count read per this interval. */
const SIGNAL_MIN_GAP_MS = 10_000;

/**
 * Query roots that pages invalidate when their live socket (lib/live.ts) reports a change, or
 * after an approval, promotion, retry, or dismissal. Their invalidation is the shell's "live
 * signal": the shell itself opens no socket.
 */
const SIGNAL_ROOTS = new Set([
  "change",
  "changes",
  "candidate",
  "candidates",
  "conflicts",
  "dead-letters",
  "tasks",
]);

/** Refreshes the count when a page invalidates a related query (debounced and rate-limited). */
function useLiveSignalRefresh(queryClient: QueryClient) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "invalidate") return;
      const root = event.query.queryKey[0];
      if (typeof root !== "string" || !SIGNAL_ROOTS.has(root)) return;
      clearTimeout(timer);
      const wait = Math.max(SIGNAL_DEBOUNCE_MS, last + SIGNAL_MIN_GAP_MS - Date.now());
      timer = setTimeout(() => {
        last = Date.now();
        void queryClient.invalidateQueries({ queryKey: NOTIFICATION_KEYS.all });
      }, wait);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [queryClient]);
}

/** Prefixes the tab title with `(n)` while n items need a decision. Survives route title changes. */
function useTitlePrefix(count: number) {
  useEffect(() => {
    const strip = (title: string) => title.replace(/^\(\d+\+?\) /, "");
    const apply = () => {
      const base = strip(document.title);
      const next = count > 0 ? `(${formatBadge(count)}) ${base}` : base;
      if (document.title !== next) document.title = next;
    };
    apply();
    // The router rewrites <title> on navigation; re-apply after it does.
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      document.title = strip(document.title);
    };
  }, [count]);
}

/** Announces (politely) when the number of items that need a decision goes up. */
function useActionAnnouncement(action: number | undefined) {
  const previous = useRef<number | undefined>(undefined);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (action === undefined) return;
    const before = previous.current;
    previous.current = action;
    if (before !== undefined && action > before) {
      setMessage(`${plural(action, "item")} ${action === 1 ? "needs" : "need"} you.`);
    }
  }, [action]);
  return message;
}

/** Calls `run` once when the browser is idle after first paint. `run` must be stable. */
function useWhenIdle(run: () => void) {
  useEffect(() => {
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(run, { timeout: 5_000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = setTimeout(run, 2_000);
    return () => clearTimeout(timer);
  }, [run]);
}

export function NotificationBell() {
  const queryClient = useQueryClient();
  const count = useQuery({
    queryKey: NOTIFICATION_KEYS.count,
    queryFn: () => getNotificationCount(),
    refetchInterval: POLL_MS,
    staleTime: 15_000,
    retry: 1,
  });
  useLiveSignalRefresh(queryClient);

  const action = count.data?.action ?? 0;
  const unread = count.data?.unread ?? 0;
  useTitlePrefix(action);
  const announcement = useActionAnnouncement(count.data?.action);

  // The popover chunk is requested once; until it renders, the placeholder bell stands in.
  const [armed, setArmed] = useState(false);
  const [openOnLoad, setOpenOnLoad] = useState(false);
  const placeholderFocused = useRef(false);
  const arm = useCallback(() => setArmed(true), []);
  useWhenIdle(arm);

  const placeholder = (
    <BellButton
      action={action}
      unread={unread}
      aria-haspopup="dialog"
      onPointerEnter={arm}
      onFocus={() => {
        placeholderFocused.current = true;
        arm();
      }}
      onBlur={() => {
        placeholderFocused.current = false;
      }}
      onClick={() => {
        setOpenOnLoad(true);
        arm();
      }}
    />
  );

  return (
    <>
      {armed ? (
        <Suspense fallback={placeholder}>
          <NotificationPopover
            action={action}
            unread={unread}
            initialOpen={openOnLoad}
            wasFocused={() => placeholderFocused.current}
          />
        </Suspense>
      ) : (
        placeholder
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}
NotificationBell.displayName = "NotificationBell";
