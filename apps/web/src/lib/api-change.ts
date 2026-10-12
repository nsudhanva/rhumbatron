import { env } from "cloudflare:workers";
import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import type { CandidateDetail, ChangeDetail, ChangeMeta } from "./api";

/**
 * Change-page server functions over the API Worker (service binding `API`), with the same call
 * pattern as `api.ts`: the browser never calls the API directly; each call runs on the web Worker
 * with the user's Clerk session token.
 *
 * The types below mirror the API responses of `GET /v1/changes/:changeId`,
 * `GET /v1/changes/:changeId/candidates`, `GET /v1/candidates/:candidateId`, and
 * `POST /v1/changes/:changeId/clarify`.
 */

/**
 * One question the system asks the requester before it builds a Change. `options` are distinct
 * readings to pick from; the form adds "Something else" with a free-text answer.
 */
export type ClarificationQuestion = { id: string; text: string; options?: string[] };

/** Why a Change waits in `needs_input`, and what it asks. Null when nothing is asked. */
export type ChangeClarification = {
  kind: "unclear" | "duplicate" | "conflict";
  summary: string;
  questions: ClarificationQuestion[];
  relatedChangeId: string | null;
  relatedGoal: string | null;
  /** Short title of the related Change. */
  relatedTitle?: string | null;
  askedAt: string;
  round: number;
};

/** The Change read with its record times and the open clarification. */
export type ChangeView = ChangeDetail &
  Partial<ChangeMeta> & { clarification?: ChangeClarification | null };

/** One acceptance criterion, judged against the composed source. */
export type CriterionAcceptance = {
  criterion: string;
  status: "met" | "not_met" | "unclear";
  citations: { path: string; quote: string }[];
};

/** The system's choice between the Candidates of one Change. */
export type CandidateSelection = { winnerCandidateId: string; reason: string };

/** A Candidate read with per-criterion acceptance and the selection decision. */
export type CandidateView = CandidateDetail & {
  acceptance?: CriterionAcceptance[] | null;
  selection?: CandidateSelection | null;
};

/** One answer, keyed by the question it answers. */
export type ClarificationAnswer = { questionId: string; text: string };

export type ClarifyInput =
  | { changeId: string; answers: ClarificationAnswer[] }
  | { changeId: string; action: "proceed_anyway" | "withdraw" };

export type ClarifyResult = { changeId: string; changeStatus?: string; status?: string };

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) throw new ApiError(401, "Sign in to continue");
  const response = await env.API.fetch(
    new Request(`https://api.internal${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
  const json = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string };
  };
  if (!response.ok || json.data === undefined) {
    throw new ApiError(response.status, json.error?.message ?? `API returned ${response.status}`);
  }
  return json.data;
}

/**
 * Answers the questions of a `needs_input` Change, or builds it as it is, or withdraws it. Only
 * the requester, an admin or the Project owner may answer; the API checks this from the session.
 */
export const clarifyChange = createServerFn({ method: "POST" })
  .inputValidator((input: ClarifyInput) => input)
  .handler(({ data }) => {
    const { changeId, ...body } = data;
    return call<ClarifyResult>(`/v1/changes/${changeId}/clarify`, { method: "POST", body });
  });
