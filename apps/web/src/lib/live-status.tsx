import { createContext, type ReactNode, useContext, useState } from "react";
import type { LiveStatus } from "./live";

/**
 * Shares the state of the page's live socket with the shell status bar (DESIGN.md 9.17).
 * `useProjectLive` reports into this automatically; pages do not call it.
 *
 * `idle` means the current page has no live socket (nothing to show as live or offline).
 */
export type ShellLiveState = { status: LiveStatus; enabled: boolean } | { status: "idle" };

type LiveStatusContextValue = {
  state: ShellLiveState;
  report: (state: ShellLiveState) => void;
};

const LiveStatusContext = createContext<LiveStatusContextValue | null>(null);

export function LiveStatusProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ShellLiveState>({ status: "idle" });
  return (
    <LiveStatusContext.Provider value={{ state, report: setState }}>
      {children}
    </LiveStatusContext.Provider>
  );
}

/** The reporter used by `useProjectLive`. A no-op outside the provider. */
export function useLiveStatusReporter() {
  return useContext(LiveStatusContext)?.report;
}

/** The live state shown in the status bar. */
export function useShellLiveState(): ShellLiveState {
  return useContext(LiveStatusContext)?.state ?? { status: "idle" };
}
