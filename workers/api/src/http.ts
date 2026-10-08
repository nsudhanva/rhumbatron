import type { ApiErrorBody, ApiErrorCode } from "@rhumbatron/protocol";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { validator } from "hono/validator";
import { z } from "zod";

export function errorBody(code: ApiErrorCode, message: string, details?: unknown): ApiErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export function fail(
  c: Context,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
) {
  return c.json(errorBody(code, message), status);
}

/**
 * Validates a request part with Zod. Invalid input returns 400 with the Zod error tree,
 * so handlers only ever see parsed, typed values.
 */
export function validate<T extends z.ZodType>(target: "json" | "query" | "param", schema: T) {
  return validator(target, (value, c) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      return c.json(
        errorBody("invalid_request", `Invalid ${target}`, z.treeifyError(result.error)),
        400,
      );
    }
    return result.data as z.output<T>;
  });
}

/**
 * Validates an outgoing body against its contract. A mismatch is a server bug, so it throws
 * and the app error handler returns a generic 500 without leaking the payload.
 */
export function respond<T extends z.ZodType>(
  c: Context,
  schema: T,
  body: z.input<T>,
  status: ContentfulStatusCode = 200,
) {
  return c.json(schema.parse(body) as z.output<T>, status);
}
