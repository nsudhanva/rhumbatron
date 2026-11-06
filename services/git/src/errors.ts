/** Error codes and HTTP status values that match the Cloudflare Artifacts binding. */

export type ErrorCode =
  | "ALREADY_EXISTS"
  | "NOT_FOUND"
  | "CREATE_IN_PROGRESS"
  | "IMPORT_IN_PROGRESS"
  | "FORK_IN_PROGRESS"
  | "INVALID_INPUT"
  | "INVALID_REPO_NAME"
  | "INVALID_TTL"
  | "INVALID_URL"
  | "REMOTE_AUTH_REQUIRED"
  | "UPSTREAM_UNAVAILABLE"
  | "MEMORY_LIMIT"
  | "INTERNAL_ERROR";

export const STATUS: Record<ErrorCode, number> = {
  ALREADY_EXISTS: 409,
  NOT_FOUND: 404,
  CREATE_IN_PROGRESS: 409,
  IMPORT_IN_PROGRESS: 409,
  FORK_IN_PROGRESS: 409,
  INVALID_INPUT: 400,
  INVALID_REPO_NAME: 400,
  INVALID_TTL: 400,
  INVALID_URL: 400,
  REMOTE_AUTH_REQUIRED: 401,
  UPSTREAM_UNAVAILABLE: 502,
  MEMORY_LIMIT: 413,
  INTERNAL_ERROR: 500,
};

export class ServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactsError";
  }
}
