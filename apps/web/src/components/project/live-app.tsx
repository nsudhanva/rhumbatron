import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { deployProjectApp, getProjectApp, removeProjectApp } from "../../lib/api";
import { Mono } from "../ui/mono";

/** Link-style actions: 24px tall at least, the WCAG 2.5.8 target size. */
const LINK = "inline-flex min-h-6 items-center text-kumo-link underline-offset-2 hover:underline";

/**
 * "Live at <host> · Open app" under the Project title (Phase 16, ADR 0020). Renders nothing where
 * live apps are off (local runs). A Project from before live apps gets a "Deploy app" action. "Remove
 * app" (P16-20) confirms in place; the Project and its history stay.
 */
export function LiveAppLine({
  projectId,
  hasSource,
  canManage = true,
}: {
  projectId: string;
  hasSource: boolean;
  /** Owner or admin: deploy, retry and remove (everyone else sees the app but cannot manage it). */
  canManage?: boolean;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["project-app", projectId],
    queryFn: () => getProjectApp({ data: projectId }),
    refetchInterval: (q) => (q.state.data?.app?.status === "building" ? 3000 : false),
  });
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => removeProjectApp({ data: projectId }),
    onSettled: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ["project-app", projectId] });
    },
  });
  const deploy = useMutation({
    mutationFn: () => deployProjectApp({ data: projectId }),
    onSuccess: () => {
      // The build runs on a Queue: poll until the pointer row shows up or changes.
      setTimeout(
        () => void queryClient.invalidateQueries({ queryKey: ["project-app", projectId] }),
        3000,
      );
    },
  });
  const view = query.data;
  if (!view?.enabled) return null;
  // Once sent, the action becomes plain text: there is nothing more to press.
  const action = (label: string) =>
    !canManage ? null : deploy.isPending || deploy.isSuccess ? (
      <span role="status">Queued</span>
    ) : (
      <button type="button" className={LINK} onClick={() => deploy.mutate()}>
        {label}
      </button>
    );

  const app = view.app;
  if (!app) {
    return hasSource ? (
      <span className="flex basis-full items-center gap-x-3">
        <span>Not live yet</span>
        <span aria-hidden>·</span>
        {action("Deploy app")}
      </span>
    ) : null;
  }
  if (app.status === "removed") {
    // Cleanup done: only the tombstone is left (its hosts answer 410), and it can publish again.
    if (app.commit === null && hasSource) {
      return (
        <span className="flex basis-full items-center gap-x-3">
          <span>App removed</span>
          <span aria-hidden>·</span>
          {action("Deploy app")}
        </span>
      );
    }
    return (
      <span className="basis-full">App removed · its bundles and data are deleted by cleanup</span>
    );
  }
  const host = new URL(app.url).host;
  return (
    <span className="flex basis-full flex-wrap items-center gap-x-3">
      <span>
        Live at{" "}
        <a href={app.url} target="_blank" rel="noreferrer" className={LINK}>
          <Mono>{host}</Mono>
        </a>
      </span>
      <span aria-hidden>·</span>
      <a href={app.url} target="_blank" rel="noreferrer" className={LINK}>
        Open app
      </a>
      {app.status === "building" && (
        <>
          <span aria-hidden>·</span>
          <span>Building</span>
        </>
      )}
      {app.status === "failed" && (
        <>
          <span aria-hidden>·</span>
          <span title={app.failureReason ?? undefined}>Latest build failed</span>
          {action("Retry")}
        </>
      )}
      {canManage && <span aria-hidden>·</span>}
      {!canManage ? null : confirming ? (
        <span className="flex items-center gap-x-3">
          {remove.isPending ? (
            <span role="status">Removing the app</span>
          ) : (
            <>
              <span>Remove the app and delete its data?</span>
              <button
                type="button"
                className="inline-flex min-h-6 items-center text-kumo-danger underline-offset-2 hover:underline"
                onClick={() => remove.mutate()}
              >
                Remove
              </button>
              <button type="button" className={LINK} onClick={() => setConfirming(false)}>
                Keep
              </button>
            </>
          )}
        </span>
      ) : (
        <button type="button" className={LINK} onClick={() => setConfirming(true)}>
          Remove app
        </button>
      )}
      {remove.isError && <span>{remove.error.message}</span>}
    </span>
  );
}
