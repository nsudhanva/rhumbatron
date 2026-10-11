import { Button, InputArea } from "@cloudflare/kumo";
import { ChatCircleText } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { type ChangeClarification, type ClarifyInput, clarifyChange } from "../../lib/api-change";
import { timeAgo } from "../../lib/format";

/**
 * "Waiting for your answer" (change status `needs_input`). The system found the request unclear,
 * a duplicate, or in conflict with another request, and asks before it builds. The requester or
 * the Project owner answers; everyone else sees who the Change waits for. The API checks who may
 * answer; this form only sends the request.
 */

const KIND: Record<ChangeClarification["kind"], { title: string; related: string }> = {
  unclear: { title: "The request needs more detail", related: "Related request" },
  duplicate: {
    title: "This looks like a request that already exists",
    related: "Existing request",
  },
  conflict: { title: "This conflicts with another request", related: "Conflicting request" },
};

export function ClarificationCard({
  changeId,
  projectId,
  clarification,
  canAnswer,
  requester,
}: {
  changeId: string;
  projectId: string;
  clarification: ChangeClarification;
  canAnswer: boolean;
  /** Who the Change waits for, as a name. */
  requester: string;
}) {
  const queryClient = useQueryClient();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const send = useMutation({
    mutationFn: (input: ClarifyInput) => clarifyChange({ data: input }),
    onSuccess: () => {
      setAnswers({});
      setConfirmWithdraw(false);
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["change", changeId] }),
        queryClient.invalidateQueries({ queryKey: ["tasks", changeId] }),
        queryClient.invalidateQueries({ queryKey: ["request-conflicts", changeId] }),
        queryClient.invalidateQueries({ queryKey: ["changes", projectId] }),
      ]),
  });
  const kind = KIND[clarification.kind];
  const pending = send.isPending ? send.variables : null;
  const pendingAction = pending && "action" in pending ? pending.action : null;

  const submitAnswers = () => {
    const list = clarification.questions.map((q) => ({
      questionId: q.id,
      text: (answers[q.id] ?? "").trim(),
    }));
    if (list.some((a) => a.text === "")) {
      setMissing(true);
      return;
    }
    setMissing(false);
    send.mutate({ changeId, answers: list });
  };

  return (
    <article
      id="clarification"
      aria-label="Questions about this request"
      className="grid gap-4 bg-kumo-elevated p-4 shadow-[inset_2px_0_0_var(--color-accent-500)]"
    >
      <header className="grid gap-1">
        <p className="type-kicker flex flex-wrap items-center gap-2 text-kumo-accent">
          <ChatCircleText size={14} aria-hidden />
          {canAnswer ? "Waiting for your answer" : `Waiting for ${requester} to answer`}
          {clarification.round > 1 && <span>· round {clarification.round}</span>}
        </p>
        <h2 className="type-h4">{kind.title}</h2>
        <p className="max-w-[760px] text-[14px] text-pretty">{clarification.summary}</p>
        {clarification.relatedChangeId && (
          <p className="text-[13px]">
            <span className="text-kumo-subtle">{kind.related}: </span>
            <Link
              to="/changes/$changeId"
              params={{ changeId: clarification.relatedChangeId }}
              className="font-semibold text-kumo-link hover:underline"
            >
              {clarification.relatedGoal ?? clarification.relatedChangeId}
            </Link>
          </p>
        )}
        <p className="text-[12px] text-kumo-subtle">
          <time dateTime={clarification.askedAt} title={clarification.askedAt}>
            Asked {timeAgo(clarification.askedAt)}
          </time>
        </p>
      </header>

      {canAnswer ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submitAnswers();
          }}
        >
          {clarification.questions.map((q, i) => (
            <InputArea
              key={q.id}
              label={clarification.questions.length > 1 ? `${i + 1}. ${q.text}` : q.text}
              value={answers[q.id] ?? ""}
              maxLength={2000}
              minRows={2}
              autoResize
              onValueChange={(value) => setAnswers((prev) => ({ ...prev, [q.id]: value }))}
            />
          ))}
          {missing && (
            <p role="alert" className="text-[12px] font-semibold text-kumo-danger">
              Answer every question, or choose "Build it as it is".
            </p>
          )}
          {send.isError && (
            <p role="alert" className="text-[12px] font-semibold text-kumo-danger">
              {send.error.message}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {clarification.questions.length > 0 && (
              <Button
                type="submit"
                variant="primary"
                loading={send.isPending && pendingAction === null}
              >
                Send answers
              </Button>
            )}
            <Button
              variant="secondary"
              loading={pendingAction === "proceed_anyway"}
              onClick={() => send.mutate({ changeId, action: "proceed_anyway" })}
            >
              Build it as it is
            </Button>
            {confirmWithdraw ? (
              <>
                <Button
                  variant="secondary"
                  loading={pendingAction === "withdraw"}
                  onClick={() => send.mutate({ changeId, action: "withdraw" })}
                >
                  Confirm withdraw
                </Button>
                {pendingAction !== "withdraw" && (
                  <Button variant="ghost" onClick={() => setConfirmWithdraw(false)}>
                    Keep the request
                  </Button>
                )}
              </>
            ) : (
              <Button variant="secondary" onClick={() => setConfirmWithdraw(true)}>
                Withdraw request
              </Button>
            )}
          </div>
          <p className="text-[12px] text-kumo-subtle">
            "Build it as it is" continues without answers. "Withdraw request" stops this request.
          </p>
        </form>
      ) : (
        <div className="grid gap-2">
          {clarification.questions.length > 0 && (
            <ol className="grid">
              {clarification.questions.map((q, i) => (
                <li
                  key={q.id}
                  className="grid grid-cols-[20px_minmax(0,1fr)] border-b border-kumo-rule py-1.5 text-[13px]"
                >
                  <span className="font-mono text-[11px] text-kumo-subtle">{i + 1}.</span>
                  <span>{q.text}</span>
                </li>
              ))}
            </ol>
          )}
          <p className="text-[13px] text-kumo-subtle">
            Only {requester} or the Project owner can answer. Work continues after an answer.
          </p>
        </div>
      )}
    </article>
  );
}
ClarificationCard.displayName = "ClarificationCard";
