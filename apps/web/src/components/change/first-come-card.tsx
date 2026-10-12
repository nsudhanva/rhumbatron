import { Button } from "@cloudflare/kumo";
import { ArrowsSplit, HourglassMedium } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  chooseFirstCome,
  type FirstComeChoice,
  getRequestWaits,
  type RequestWait,
} from "../../lib/api-board";
import { timeAgo } from "../../lib/format";

/**
 * First-come conflicts (ADR 0032). Two requests of different people conflict. The earlier request
 * keeps working; the later one waits until the earlier requester chooses.
 *
 * - On the earlier request: "<name>'s request conflicts with yours", with "Keep mine" and
 *   "Apply theirs after mine" for the earlier requester, and who decides for everyone else.
 * - On the later request: "Waiting for <name> to choose", then "Waiting for <request> to finish".
 *
 * Renders nothing when no wait is open. The API checks who may choose; this card only sends it.
 */

const WAITING = new Set(["awaiting_choice", "queued"]);
/** The slow poll while a wait is open: the choice or the earlier request can end it any time. */
const POLL_MS = 15_000;

const firstName = (wait: RequestWait) => wait.firstRequester.name ?? "the person who asked first";
const laterName = (wait: RequestWait) => wait.laterRequester.name ?? "Another person";

export function FirstComeCard({ changeId, projectId }: { changeId: string; projectId: string }) {
  const waits = useQuery({
    queryKey: ["request-waits", changeId],
    queryFn: () => getRequestWaits({ data: changeId }),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((w) => w.choice === null || WAITING.has(w.laterStatus))
        ? POLL_MS
        : false,
  });
  const open = (waits.data ?? []).filter(
    (w) =>
      WAITING.has(w.laterStatus) &&
      // The earlier request shows only an open question; the later request shows its wait.
      (w.laterChangeId === changeId || w.choice === null),
  );
  if (open.length === 0) return null;
  return (
    <div className="grid gap-3">
      {open.map((wait) =>
        wait.laterChangeId === changeId ? (
          <WaitingCard key={wait.id} wait={wait} />
        ) : (
          <ChoiceCard key={wait.id} wait={wait} changeId={changeId} projectId={projectId} />
        ),
      )}
    </div>
  );
}
FirstComeCard.displayName = "FirstComeCard";

/** Conflicting criteria, the earlier request's text first. */
function ConflictPairs({ wait, firstLabel }: { wait: RequestWait; firstLabel: string }) {
  if (wait.conflicts.length === 0) return null;
  return (
    <ul className="grid gap-2 text-[13px]">
      {wait.conflicts.map((pair) => (
        <li key={`${pair.first}|${pair.later}`} className="grid gap-0.5 bg-kumo-base px-3 py-2">
          <span>
            <span className="text-kumo-subtle">{firstLabel}: </span>
            {pair.first}
          </span>
          <span>
            <span className="text-kumo-subtle">{laterName(wait)}: </span>
            {pair.later}
          </span>
        </li>
      ))}
    </ul>
  );
}
ConflictPairs.displayName = "FirstComeConflictPairs";

function ChoiceCard({
  wait,
  changeId,
  projectId,
}: {
  wait: RequestWait;
  changeId: string;
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const choose = useMutation({
    mutationFn: (choice: FirstComeChoice) =>
      chooseFirstCome({ data: { changeId: wait.laterChangeId, choice } }),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["request-waits", changeId] }),
        queryClient.invalidateQueries({ queryKey: ["request-waits", wait.laterChangeId] }),
        queryClient.invalidateQueries({ queryKey: ["change", wait.laterChangeId] }),
        queryClient.invalidateQueries({ queryKey: ["changes", projectId] }),
      ]),
  });
  const who = laterName(wait);
  const pending = choose.isPending ? choose.variables : null;
  return (
    <article
      aria-label="A later request conflicts with this one"
      className="grid gap-3 bg-kumo-elevated p-4 shadow-[inset_2px_0_0_var(--color-accent-500)]"
    >
      <header className="grid gap-1">
        <p className="type-kicker flex items-center gap-2 text-kumo-accent">
          <ArrowsSplit size={14} aria-hidden />
          {wait.canChoose ? "Waiting for your choice" : `Waiting for ${firstName(wait)} to choose`}
        </p>
        <h2 className="type-h4">
          {wait.canChoose
            ? `${who}'s request conflicts with yours`
            : `${who}'s request conflicts with this one`}
        </h2>
        <p className="max-w-[760px] text-[14px] text-pretty">
          {who} asked:{" "}
          <Link
            to="/changes/$changeId"
            params={{ changeId: wait.laterChangeId }}
            className="font-semibold text-kumo-link hover:underline"
            title={wait.laterGoal}
          >
            {wait.laterTitle}
          </Link>
          . This request came first and keeps working. Nothing of {who}'s request is built until{" "}
          {wait.canChoose ? "you choose" : `${firstName(wait)} chooses`}.
        </p>
      </header>
      <ConflictPairs wait={wait} firstLabel={wait.canChoose ? "Yours" : firstName(wait)} />
      {wait.canChoose ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              loading={pending === "keep_mine"}
              disabled={choose.isPending}
              onClick={() => choose.mutate("keep_mine")}
            >
              Keep mine
            </Button>
            <Button
              variant="primary"
              loading={pending === "apply_theirs"}
              disabled={choose.isPending}
              onClick={() => choose.mutate("apply_theirs")}
            >
              Apply theirs after mine
            </Button>
          </div>
          <p className="text-[12px] text-kumo-subtle">
            Keep mine: {who}'s request ends as not built. Apply theirs after mine: it plans when
            this request finishes, on the new app, and its detail wins.
          </p>
          {choose.isError && (
            <p role="alert" className="text-[12px] font-semibold text-kumo-danger">
              {choose.error.message}
            </p>
          )}
        </div>
      ) : (
        <p className="text-[12px] text-kumo-subtle">
          Only {firstName(wait)} chooses. Asked{" "}
          <time dateTime={wait.askedAt} title={wait.askedAt}>
            {timeAgo(wait.askedAt)}
          </time>
          .
        </p>
      )}
    </article>
  );
}
ChoiceCard.displayName = "FirstComeChoiceCard";

function WaitingCard({ wait }: { wait: RequestWait }) {
  const name = firstName(wait);
  const queued = wait.laterStatus === "queued";
  return (
    <article
      aria-label="This request waits for an earlier request"
      className="grid gap-3 bg-kumo-warning-tint px-3.5 py-3 text-[13px]"
    >
      <p className="flex items-center gap-2 font-semibold text-kumo-warning">
        <HourglassMedium size={16} aria-hidden />
        {queued ? `Waiting for "${wait.firstTitle}" to finish` : `Waiting for ${name} to choose`}
      </p>
      <p className="max-w-[760px] text-pretty">
        {queued ? (
          <>
            {name} chose to apply this request after theirs. It plans on the new app when{" "}
            <FirstLink wait={wait} /> finishes.
          </>
        ) : (
          <>
            This request conflicts with <FirstLink wait={wait} />, which {name} asked for first.{" "}
            {name} chooses: keep their version, or apply this request after theirs. Nothing is built
            or spent while it waits.
          </>
        )}
      </p>
      {!queued && <ConflictPairs wait={wait} firstLabel={name} />}
      {!queued && (
        <p className="text-[12px] text-kumo-subtle">
          Asked{" "}
          <time dateTime={wait.askedAt} title={wait.askedAt}>
            {timeAgo(wait.askedAt)}
          </time>
          . Without a choice by{" "}
          <time dateTime={wait.expiresAt} title={wait.expiresAt}>
            {new Date(wait.expiresAt).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
            })}
          </time>
          , {name}'s version stays.
        </p>
      )}
    </article>
  );
}
WaitingCard.displayName = "FirstComeWaitingCard";

function FirstLink({ wait }: { wait: RequestWait }) {
  return (
    <Link
      to="/changes/$changeId"
      params={{ changeId: wait.firstChangeId }}
      className="font-semibold text-kumo-link hover:underline"
    >
      {wait.firstTitle}
    </Link>
  );
}
FirstLink.displayName = "FirstComeFirstLink";
