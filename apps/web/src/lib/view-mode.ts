import { type ReactNode, useSyncExternalStore } from "react";

/**
 * "Show technical details" (research 7.1). The switch sits at the bottom of the Advanced group in
 * the sidebar; pages only read it. The stored values keep their old names:
 *
 *   "product" (default)  technical details hidden: plain words, no IDs or internal names.
 *   "systems"            technical details shown: event types, IDs, model routes, internal names.
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
 *   // Or branch when the two differ in detail:
 *   const view = useViewMode(); // "product" | "systems"
 *   const columns = view === "systems" ? [...base, "Event ID"] : base;
 *
 * The choice is stored per browser (localStorage, best effort). The server always renders with
 * technical details hidden; the client switches after hydration when the stored choice is shown.
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

/** Shows or hides technical details on every page and stores the choice for the next visit. */
export function setViewMode(next: ViewMode) {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage blocked: the choice still applies for this page view.
  }
  current = next;
  emit();
}

/** "systems" when technical details are shown, else "product" (the default). */
export function useViewMode(): ViewMode {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Renders `children` only while technical details are shown. `fallback` (optional) renders
 * otherwise, for example a one-line summary of what the details would show.
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
