import { z } from "zod";

/** Machine-readable error codes returned by every Rhumbatron API. */
export const ApiErrorCode = z.enum([
  "invalid_request",
  "unauthorized",
  "forbidden",
  /** The signed-in person waits for, or was refused, platform access (ADR 0033). */
  "approval_required",
  "not_found",
  "conflict",
  /** A usage cap refuses the request (for example the monthly Sandbox seconds). */
  "rate_limited",
  "internal",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

/** Error body: `{ error: { code, message, details? } }`. */
export const ApiErrorBody = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

/** Success body: `{ data }`. */
export const apiData = <T extends z.ZodType>(data: T) => z.object({ data });

export const ServiceInfo = z.object({
  service: z.string(),
  environment: z.string(),
});
export type ServiceInfo = z.infer<typeof ServiceInfo>;

/** `/health` stays unwrapped so load balancers and smoke checks can read it directly. */
export const HealthResponse = ServiceInfo.extend({ ok: z.literal(true) });
export type HealthResponse = z.infer<typeof HealthResponse>;

export const VersionResponse = apiData(ServiceInfo);
export type VersionResponse = z.infer<typeof VersionResponse>;
