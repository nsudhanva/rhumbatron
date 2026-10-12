import type { AccessStatus } from "@rhumbatron/protocol";

/**
 * Account access (sign-up approval). `GET /v1/me` returns `accessStatus`. A user who is not
 * `approved` gets 403 `approval_required` from every other API route; the web shows the access
 * gate page instead of the app (components/shell/access-gate.tsx).
 *
 * The API helpers (lib/api*.ts) build their error message with `apiErrorMessage`, so a 403
 * `approval_required` keeps a fixed prefix through the server function boundary. The query and
 * mutation caches (router.tsx) see that prefix and read `GET /v1/me` again, which switches the
 * page to the gate.
 */

const APPROVAL_REQUIRED_PREFIX = "[approval_required]";

type ApiErrorBody = { code?: string; message?: string } | undefined;

/** The message of a failed API call. */
export function apiErrorMessage(status: number, error: ApiErrorBody): string {
  if (status === 403 && error?.code === "approval_required") {
    return `${APPROVAL_REQUIRED_PREFIX} Your account is not approved.`;
  }
  return error?.message ?? `API returned ${status}`;
}

/** True when an API call failed because the signed-in account is not approved. */
export function isApprovalRequired(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(APPROVAL_REQUIRED_PREFIX);
}

/** Pending and declined accounts see only the access gate page. */
export function isBlocked(status: AccessStatus | undefined): status is "pending" | "declined" {
  return status === "pending" || status === "declined";
}
