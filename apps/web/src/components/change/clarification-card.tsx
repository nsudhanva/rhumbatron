import { Button, InputArea, Radio } from "@cloudflare/kumo";
import { ChatCircleText } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  type ChangeClarification,
  type ClarificationQuestion,
  type ClarifyInput,
  clarifyChange,
} from "../../lib/api-change";
import { changeLabel, timeAgo } from "../../lib/format";

/**
 * "Waiting for your answer" (change status `needs_input`). The system found the request unclear,
 * a duplicate, or in conflict with another request, and asks before it builds. The requester, an
 * admin or the owner answers; everyone else sees who the Change waits for. The API checks who
 * may answer; this form only sends the request.
 *
 * Each question has its own answer. A question with readings shows them as choices plus
 * "Something else" with a free-text field. A question left open becomes an assumption of the
 * planner. The intake asks one round only: after this answer the request plans.
 */

/** Radio value of the free-text choice. */
const OTHER = "__something_else__";

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
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const send = useMutation({
    mutationFn: (input: ClarifyInput) => clarifyChange({ data: input }),
    onSuccess: () => {
      setAnswers({});
      setChoices({});
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

  /** The picked reading, or the free text when there are no readings or "Something else". */
  const answerOf = (q: ClarificationQuestion) => {
    const choice = choices[q.id];
    if (q.options?.length && choice && choice !== OTHER) return choice;
    return (answers[q.id] ?? "").trim();
  };

  const submitAnswers = () => {
    const list = clarification.questions
      .map((q) => ({ questionId: q.id, text: answerOf(q) }))
      .filter((a) => a.text !== "");
    if (list.length === 0) {
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
              title={clarification.relatedGoal ?? undefined}
            >
              {clarification.relatedGoal
                ? changeLabel({
                    goal: clarification.relatedGoal,
                    title: clarification.relatedTitle,
                  })
                : clarification.relatedChangeId}
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
          {clarification.questions.map((q, i) => {
            const label = clarification.questions.length > 1 ? `${i + 1}. ${q.text}` : q.text;
            const free = (
              <InputArea
                label={q.options?.length ? "Your answer" : label}
                value={answers[q.id] ?? ""}
                maxLength={2000}
                minRows={2}
                autoResize
                onValueChange={(value) => setAnswers((prev) => ({ ...prev, [q.id]: value }))}
              />
            );
            if (!q.options?.length) return <div key={q.id}>{free}</div>;
            return (
              <div key={q.id} className="grid gap-2">
                <Radio.Group
                  legend={label}
                  value={choices[q.id] ?? ""}
                  onValueChange={(value) => setChoices((prev) => ({ ...prev, [q.id]: value }))}
                >
                  {q.options.map((option) => (
                    <Radio.Item key={option} label={option} value={option} />
                  ))}
                  <Radio.Item label="Something else" value={OTHER} />
                </Radio.Group>
                {choices[q.id] === OTHER && free}
              </div>
            );
          })}
          {missing && (
            <p role="alert" className="text-[12px] font-semibold text-kumo-danger">
              Answer at least one question, or choose "Build it as it is".
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
            {clarification.questions.length > 1 &&
              "A question you leave open becomes an assumption of the planner. "}
            "Build it as it is" continues without answers, and the planner decides. "Withdraw
            request" stops this request.
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
                  <span className="font-mono text-[12px] text-kumo-subtle">{i + 1}.</span>
                  <span>
                    {q.text}
                    {q.options?.length ? (
                      <span className="block text-[12px] text-kumo-subtle">
                        {q.options.join(" · ")}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <p className="text-[13px] text-kumo-subtle">
            Only {requester}, an admin or the owner can answer. Work continues after an answer.
          </p>
        </div>
      )}
    </article>
  );
}
ClarificationCard.displayName = "ClarificationCard";
