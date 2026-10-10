import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deployProjectApp, getProjectApp } from "../../lib/api";
import { Mono } from "../ui/mono";

const LINK = "text-kumo-link underline-offset-2 hover:underline";

/**
 * "Live at <host> · Open app" under the Project title (Phase 16, ADR 0020). Renders nothing where
 * live apps are off (dev). A Project from before live apps gets a "Deploy app" action.
 */
export function LiveAppLine({ projectId, hasSource }: { projectId: string; hasSource: boolean }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["project-app", projectId],
    queryFn: () => getProjectApp({ data: projectId }),
    refetchInterval: (q) => (q.state.data?.app?.status === "building" ? 3000 : false),
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
  const action = (label: string) => (
    <button
      type="button"
      className={LINK}
      disabled={deploy.isPending}
      onClick={() => deploy.mutate()}
    >
      {deploy.isPending || deploy.isSuccess ? "Queued" : label}
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
  if (app.status === "removed") return <span className="basis-full">App removed</span>;
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
    </span>
  );
}
