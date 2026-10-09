import { type ReactNode, useSyncExternalStore } from "react";

/**
 * Product View / Systems View (AGENTS.md 38.7). The header holds the toggle; pages only read it.
 *
 * Product View (the default) shows user outcomes. Systems View adds the machinery: K2 flow, Queue
 * flow, Durable Object ownership, model routes, Sandbox state and cost details.
 *
 * Usage in a page:
 *
 *   import { SystemsOnly, useViewMode } from "../lib/view-mode";
 *
 *   // Wrap a block that only technical users need:
 *   <SystemsOnly>
 *     <Section label="Model routes">...</Section>
 *   </SystemsOnly>
 *
 *   // Or branch when the two views differ in detail:
 *   const view = useViewMode(); // "product" | "systems"
 *   const columns = view === "systems" ? [...base, "Durable Object", "Queue"] : base;
 *
 * The choice is stored per browser (localStorage, best effort). The server always renders
 * Product View; the client switches after hydration when the stored choice is Systems.
 */

export type ViewMode = "product" | "systems";

const STORAGE_KEY = "rh-view";
const DEFAULT: ViewMode = "product";

let current: ViewMode | null = null;
const listeners = new Set<() => void>();

function readStored(): ViewMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === "systems" ? "systems" : DEFAULT;
  } catch {
    // Storage blocked: fall back to the default.
    return DEFAULT;
  }
}

function getSnapshot(): ViewMode {
  if (current === null) current = readStored();
  return current;
}

function getServerSnapshot(): ViewMode {
  return DEFAULT;
}

function emit() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== STORAGE_KEY) return;
  current = readStored();
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

/** Sets the view for every component on the page and stores it for the next visit. */
export function setViewMode(next: ViewMode) {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage blocked: the choice still applies for this page view.
  }
  current = next;
  emit();
}

/** The current view: "product" (default) or "systems". */
export function useViewMode(): ViewMode {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Renders `children` only in Systems View. `fallback` (optional) renders in Product View, for
 * example a one-line summary of what Systems View would show.
 */
export function SystemsOnly({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}): ReactNode {
  return useViewMode() === "systems" ? children : fallback;
}
