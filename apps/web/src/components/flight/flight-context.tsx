import { createContext, type ReactNode, useContext } from "react";
import type { LiveStatus } from "../../lib/live";
import type { FlightModel, FlightState } from "./flight-model";

/**
 * Debug view data context. The route (flight-page.tsx, Worker 1) derives the model from
 * API records (use-flight-data.ts), folds it at the time-machine instant, and provides both here.
 * Panels and inspectors call `useFlight()` and read the folded `state`; they never fetch.
 *
 *   const { state, model } = useFlight();
 *   const task = state.tasks[taskId];
 */
export type FlightContextValue = {
  model: FlightModel;
  /** The fold at the current time-machine instant (live: every fact). */
  state: FlightState;
  /** Every source has answered once (or failed). Until then, panels show skeletons. */
  ready: boolean;
  socket: LiveStatus;
  projectId: string;
  changeId: string;
};

const FlightContext = createContext<FlightContextValue | null>(null);

export function FlightProvider({
  value,
  children,
}: {
  value: FlightContextValue;
  children: ReactNode;
}) {
  return <FlightContext.Provider value={value}>{children}</FlightContext.Provider>;
}
FlightProvider.displayName = "FlightProvider";

export function useFlight(): FlightContextValue {
  const value = useContext(FlightContext);
  if (!value) throw new Error("useFlight must be used inside <FlightProvider>");
  return value;
}
