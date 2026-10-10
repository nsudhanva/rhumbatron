import { Button } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type DeadLetter,
  dismissDeadLetter,
  getDeadLetters,
  type LimitBlock,
  retryDeadLetter,
} from "../lib/api";
import { timeAgo } from "../lib/format";
import { Banner } from "./candidate/banner";
import { Mono } from "./ui/mono";

/** Dead letters are rare and change slowly: a minute is fresh enough and costs one D1 read. */
const POLL_MS = 60_000;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Operator banners (DESIGN.md 8.5; AGENTS.md sections 42.7 and 44). Danger: commands that failed
 * after their Queue retries, each with Retry and Dismiss. Attention: Tasks and Changes a section 44
 * limit stopped or delays, with the exact limit. Renders nothing when there is nothing to act on.
 * On a Change page, pass `changeId` to show only that Change.
 */
export function DeadLetters({
  projectId,
  changeId,
}: {
  projectId: string | undefined;
  changeId?: string | undefined;
}) {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ["dead-letters", projectId, changeId ?? null],
    queryFn: () => getDeadLetters({ data: { projectId: projectId ?? "", changeId } }),
    enabled: !!projectId,
    refetchInterval: POLL_MS,
  });
  const settle = () => {
    void queryClient.invalidateQueries({ queryKey: ["dead-letters", projectId] });
    if (changeId) {
      void queryClient.invalidateQueries({ queryKey: ["change", changeId] });
      void queryClient.invalidateQueries({ queryKey: ["tasks", changeId] });
    } else {
      void queryClient.invalidateQueries({ queryKey: ["changes", projectId] });
    }
  };
  const retry = useMutation({
    mutationFn: (id: string) => retryDeadLetter({ data: id }),
    onSettled: settle,
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => dismissDeadLetter({ data: id }),
    onSettled: settle,
  });

  const letters = state.data?.deadLetters ?? [];
  // One row per stop: a Task stop already names its Change, so skip that Change's own row.
  const allLimits = state.data?.limits ?? [];
  const stoppedChanges = new Set(
    allLimits.filter((b) => b.scope === "task").map((b) => b.changeId),
  );
  const limits = allLimits.filter((b) => b.scope === "task" || !stoppedChanges.has(b.changeId));
  if (letters.length === 0 && limits.length === 0) return null;
  const actionError = retry.error ?? dismiss.error;

  return (
    <div className="grid gap-2">
      {letters.length > 0 && (
        <Banner family="danger" title={`${plural(letters.length, "command")} failed after retries`}>
          <p>
            Each was retried by its Queue, then moved to the dead-letter Queue, and its Task is
            blocked. Retry sends the same command (same command ID) back to its Queue; work that
            already happened is not repeated. Dismiss accepts the failure.
          </p>
          {actionError && <p className="mt-1 font-semibold">{actionError.message}</p>}
          <ul className="mt-2 grid">
            {letters.map((letter) => (
              <DeadLetterRow
                key={letter.id}
                letter={letter}
                showChange={!changeId}
                retrying={retry.isPending && retry.variables === letter.id}
                dismissing={dismiss.isPending && dismiss.variables === letter.id}
                busy={retry.isPending || dismiss.isPending}
                onRetry={() => retry.mutate(letter.id)}
                onDismiss={() => dismiss.mutate(letter.id)}
              />
            ))}
          </ul>
        </Banner>
      )}
      {limits.length > 0 && (
        <Banner
          family="attention"
          title={`${plural(limits.length, "item")} stopped or waiting on a limit`}
        >
          <ul className="grid gap-1">
            {limits.map((block) => (
              <LimitRow key={`${block.scope}:${block.id}`} block={block} showChange={!changeId} />
            ))}
          </ul>
        </Banner>
      )}
    </div>
  );
}
DeadLetters.displayName = "DeadLetters";

function ChangeLink({ changeId }: { changeId: string }) {
  return (
    <Link
      to="/changes/$changeId"
      params={{ changeId }}
      className="underline decoration-current/40 underline-offset-2 hover:decoration-current"
    >
      <Mono>{changeId}</Mono>
    </Link>
  );
}

function DeadLetterRow({
  letter,
  showChange,
  retrying,
  dismissing,
  busy,
  onRetry,
  onDismiss,
}: {
  letter: DeadLetter;
  showChange: boolean;
  retrying: boolean;
  dismissing: boolean;
  busy: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-current/20 py-1.5">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 font-normal">
        <Mono>{letter.commandType}</Mono>
        {letter.taskTitle && <span className="truncate">{letter.taskTitle}</span>}
        {showChange && letter.changeId && <ChangeLink changeId={letter.changeId} />}
        {!letter.changeId && <span>Project command</span>}
        <time dateTime={letter.lastSeenAt} title={letter.lastSeenAt} className="opacity-80">
          {timeAgo(letter.lastSeenAt)}
        </time>
        {letter.deadCount > 1 && (
          <span className="opacity-80">failed {letter.deadCount} times</span>
        )}
      </span>
      <span className="flex shrink-0 gap-2">
        <Button
          size="sm"
          variant="secondary"
          className="ring-current"
          loading={retrying}
          disabled={busy && !retrying}
          onClick={onRetry}
        >
          Retry
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="ring-current"
          loading={dismissing}
          disabled={busy && !dismissing}
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      </span>
    </li>
  );
}

function LimitRow({ block, showChange }: { block: LimitBlock; showChange: boolean }) {
  return (
    <li className="grid gap-0.5 font-normal">
      <span className="flex flex-wrap items-center gap-x-2">
        <span className="font-semibold">
          {block.scope === "change" ? "Change" : "Task"}
          {block.scope === "task" && block.title ? ` · ${block.title}` : ""}
        </span>
        {showChange && <ChangeLink changeId={block.changeId} />}
      </span>
      <span>{block.reason}</span>
    </li>
  );
}
