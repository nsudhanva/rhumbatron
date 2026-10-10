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
import { timeAgo, truncate } from "../lib/format";
import { Banner } from "./candidate/banner";

/** Dead letters are rare and change slowly: a minute is fresh enough and costs one D1 read. */
const POLL_MS = 60_000;

/** The shared read (also used by the Overview to decide whether "Needs you" has rows). */
export function deadLettersQuery(projectId: string | undefined, changeId?: string | undefined) {
  return {
    queryKey: ["dead-letters", projectId, changeId ?? null],
    queryFn: () => getDeadLetters({ data: { projectId: projectId ?? "", changeId } }),
    enabled: !!projectId,
    refetchInterval: POLL_MS,
  };
}

/**
 * Stuck jobs and paused work (research 7.6 "Stuck job", "Paused: budget reached"). A stuck job is
 * a background command that failed after its retries; Retry sends it again, Dismiss accepts the
 * failure. Paused rows name the limit that stopped a change or task. Renders nothing when there
 * is nothing to act on. On a Change page, pass `changeId` to show only that Change.
 */
export function DeadLetters({
  projectId,
  changeId,
}: {
  projectId: string | undefined;
  changeId?: string | undefined;
}) {
  const queryClient = useQueryClient();
  const state = useQuery(deadLettersQuery(projectId, changeId));
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
  const limits = state.data?.limits ?? [];
  if (letters.length === 0 && limits.length === 0) return null;
  const actionError = retry.error ?? dismiss.error;
  const only = letters.length === 1 ? letters[0] : undefined;

  return (
    <div className="grid gap-2">
      {letters.length > 0 && (
        <Banner
          family="attention"
          className="rounded-lg"
          title={
            only
              ? `Stuck job: ${only.taskTitle ?? "a background job"}`
              : `${letters.length} stuck jobs`
          }
        >
          <p>
            A background job failed repeatedly. Retry sends it again; Dismiss accepts the failure.
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
          className="rounded-lg"
          title={
            limits.length === 1
              ? limitSentence(limits[0] as LimitBlock)
              : `${limits.length} items paused`
          }
        >
          {limits.length > 1 && (
            <ul className="grid gap-1">
              {limits.map((block) => (
                <LimitRow key={`${block.scope}:${block.id}`} block={block} showChange={!changeId} />
              ))}
            </ul>
          )}
          {limits.length === 1 && !changeId && (
            <ChangeLink changeId={(limits[0] as LimitBlock).changeId} />
          )}
        </Banner>
      )}
    </div>
  );
}
DeadLetters.displayName = "DeadLetters";

const isBudget = (block: LimitBlock) =>
  block.status === "budget_blocked" || /cost|budget|usd/i.test(block.limit);

/** "'Add shared wishlists' paused: budget reached", or the limit's own sentence. */
function limitSentence(block: LimitBlock) {
  const name = block.title ? `'${truncate(block.title, 60)}'` : null;
  if (isBudget(block)) return `${name ?? "This change"} paused: budget reached`;
  return name ? `${name}: ${block.reason}` : block.reason;
}

function ChangeLink({ changeId }: { changeId: string }) {
  return (
    <Link
      to="/changes/$changeId"
      params={{ changeId }}
      className="w-fit underline decoration-current/40 underline-offset-2 hover:decoration-current"
    >
      Open change
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
        <span className="truncate" title={letter.commandType}>
          {letter.taskTitle ?? (letter.changeId ? "Background job" : "Project job")}
        </span>
        <time dateTime={letter.lastSeenAt} title={letter.lastSeenAt} className="opacity-80">
          {timeAgo(letter.lastSeenAt)}
        </time>
        {letter.deadCount > 1 && (
          <span className="opacity-80">failed {letter.deadCount} times</span>
        )}
        {showChange && letter.changeId && <ChangeLink changeId={letter.changeId} />}
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
    <li className="flex flex-wrap items-center gap-x-2 font-normal">
      <span>{limitSentence(block)}</span>
      {showChange && <ChangeLink changeId={block.changeId} />}
    </li>
  );
}
