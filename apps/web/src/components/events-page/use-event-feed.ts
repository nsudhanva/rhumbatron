import { useCallback, useEffect, useRef, useState } from "react";
import {
  FEED_FIRST_LIMIT,
  FEED_PAGE_LIMIT,
  type FeedEvent,
  type FeedPage,
  mergeEvents,
} from "./feed-model";

export type FeedCursor = { after?: number; before?: number; limit: number };
export type FetchFeedPage = (cursor: FeedCursor) => Promise<FeedPage>;

/** Newer pages read per pull. Past this the stream restarts from the newest page. */
const MAX_PULL_PAGES = 5;
/** Rows kept in memory. Older rows drop off and come back through "Load older". */
const MAX_ROWS = 2000;

type FeedState = {
  status: "loading" | "ready" | "error";
  error: string | null;
  events: FeedEvent[];
  /** Cursor for newer events. */
  newest: number;
  /** Cursor for older events. Null when nothing older is known. */
  oldest: number | null;
  hasOlder: boolean;
};

const INITIAL: FeedState = {
  status: "loading",
  error: null,
  events: [],
  newest: 0,
  oldest: null,
  hasOlder: false,
};

function trim(state: FeedState): FeedState {
  if (state.events.length <= MAX_ROWS) return state;
  const events = state.events.slice(0, MAX_ROWS);
  return { ...state, events, oldest: events.at(-1)?.seq ?? state.oldest, hasOlder: true };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const fromFirstPage = (page: FeedPage): FeedState => ({
  status: "ready",
  error: null,
  events: page.events,
  newest: page.nextAfter,
  oldest: page.nextBefore,
  hasOlder: page.hasMore,
});

/** Cache key of the first page a route loader read on the server (lib/ssr-data.ts). */
export const firstPageKey = (projectId: string, changeId: string | undefined) =>
  ["events-page-feed", projectId, changeId ?? null] as const;

/**
 * The event stream of one scope (a Project or a Change): the newest page first, then newer
 * events by the `after` cursor on every `pull()`, and older ones by the `before` cursor on
 * `loadOlder()`. Pulls never overlap; a pull asked for while one runs runs once more after it,
 * so no signal is lost. `scopeKey` resets the stream.
 *
 * `seed` is the first page when the server already read it: the stream starts from it (so the
 * server-rendered HTML lists the events) and the first client read takes only newer events.
 */
export function useEventFeed(scopeKey: string, fetchPage: FetchFeedPage, seed?: FeedPage) {
  const [state, setState] = useState<FeedState>(() => (seed ? fromFirstPage(seed) : INITIAL));
  const seededScope = useRef(seed ? scopeKey : null);
  const [pullError, setPullError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);

  const fetchRef = useRef(fetchPage);
  const stateRef = useRef(state);
  const pulling = useRef<Promise<void> | null>(null);
  const pullAgain = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    fetchRef.current = fetchPage;
  });
  useEffect(() => {
    stateRef.current = state;
  });

  const loadFirst = useCallback(async () => {
    const token = ++generation.current;
    setState((s) => ({ ...s, status: s.events.length ? s.status : "loading", error: null }));
    try {
      const page = await fetchRef.current({ limit: FEED_FIRST_LIMIT });
      if (token !== generation.current) return;
      const next = fromFirstPage(page);
      stateRef.current = next;
      setState(next);
      setPullError(null);
    } catch (error) {
      if (token !== generation.current) return;
      setState((s) => ({
        ...s,
        status: s.events.length ? "ready" : "error",
        error: message(error),
      }));
    }
  }, []);

  const pullOnce = useCallback(async () => {
    const token = generation.current;
    let newest = stateRef.current.newest;
    let incoming: FeedEvent[] = [];
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const result = await fetchRef.current({ after: newest, limit: FEED_PAGE_LIMIT });
      if (token !== generation.current) return;
      incoming = incoming.concat(result.events);
      newest = Math.max(newest, result.nextAfter);
      if (!result.hasMore) {
        setState((s) =>
          trim({
            ...s,
            events: mergeEvents(s.events, incoming),
            newest: Math.max(s.newest, newest),
          }),
        );
        setPullError(null);
        return;
      }
    }
    // Too far behind to page forward: start again from the newest page.
    await loadFirst();
  }, [loadFirst]);

  /** Reads newer events. Safe to call on every live signal. */
  const pull = useCallback(() => {
    if (stateRef.current.status !== "ready") return;
    if (pulling.current) {
      pullAgain.current = true;
      return;
    }
    const run = async () => {
      do {
        pullAgain.current = false;
        try {
          await pullOnce();
        } catch (error) {
          setPullError(message(error));
          pullAgain.current = false;
        }
      } while (pullAgain.current);
      pulling.current = null;
    };
    pulling.current = run();
  }, [pullOnce]);

  // A new scope starts a new stream. A server-read first page only needs the newer events.
  useEffect(() => {
    if (seededScope.current === scopeKey) {
      seededScope.current = null;
      pull();
    } else {
      stateRef.current = INITIAL;
      setState(INITIAL);
      setPullError(null);
      setOlderError(null);
      void loadFirst();
    }
    return () => {
      generation.current += 1;
    };
  }, [scopeKey, loadFirst, pull]);

  /** Reads the page of events just older than the oldest row shown. */
  const loadOlder = useCallback(async () => {
    const { oldest, hasOlder, status } = stateRef.current;
    if (status !== "ready" || !hasOlder || oldest === null) return;
    const token = generation.current;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await fetchRef.current({ before: oldest, limit: FEED_PAGE_LIMIT });
      if (token !== generation.current) return;
      setState((s) => ({
        ...s,
        events: mergeEvents(s.events, page.events),
        oldest: page.nextBefore ?? s.oldest,
        hasOlder: page.hasMore,
      }));
    } catch (error) {
      if (token === generation.current) setOlderError(message(error));
    } finally {
      if (token === generation.current) setLoadingOlder(false);
    }
  }, []);

  return {
    ...state,
    pullError,
    loadingOlder,
    olderError,
    pull,
    loadOlder,
    retry: loadFirst,
  };
}
