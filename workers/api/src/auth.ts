import { verifyToken } from "@clerk/backend";
import { createMiddleware } from "hono/factory";
import { accessGate } from "./access.ts";
import { fail } from "./http.ts";

export type AuthVariables = {
  /** Clerk user ID (`sub` claim) of the verified session. */
  authSubject: string;
};

/**
 * Authorized-party (azp) policy. A present azp must match an allowed origin.
 * A missing azp (tokens minted with the Backend API) passes only when allowMissing is true.
 * Prod sets it false.
 */
export function azpAllowed(azp: unknown, parties: string[], allowMissing: boolean): boolean {
  if (azp === undefined || azp === null || azp === "") return allowMissing;
  return typeof azp === "string" && parties.includes(azp);
}

type Claims = { sub?: unknown; azp?: unknown };

/**
 * @clerk/backend 3.x types verifyToken as `{ data } | { errors }`, but at runtime it can return the
 * JWT payload directly and throw on failure. Accept both shapes.
 */
export function claimsFrom(result: unknown): Claims | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as { data?: unknown; errors?: unknown };
  if (r.errors) return undefined;
  if (r.data && typeof r.data === "object") return r.data as Claims;
  return r as Claims;
}

/** Logs why a token was rejected. Never logs the token itself. */
function logRejection(reason: string, message: string) {
  console.warn(JSON.stringify({ event: "auth.rejected", reason, message: message.slice(0, 200) }));
}

/**
 * Requires a valid Clerk session token in `Authorization: Bearer <token>`.
 * The azp check runs here (not in verifyToken), so the azp policy can accept backend-minted tokens.
 * Then the access gate (access.ts) refuses a person who is not approved, except on `GET /v1/me`.
 */
export const requireAuth = createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(
  async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) return fail(c, 401, "unauthorized", "Missing session token");

    const parties = c.env.CLERK_AUTHORIZED_PARTIES.split(",").map((p) => p.trim());
    const allowMissingAzp = c.env.CLERK_ALLOW_MISSING_AZP === "true";
    let subject: unknown;
    try {
      const result = await verifyToken(token, { secretKey: c.env.CLERK_SECRET_KEY });
      const claims = claimsFrom(result);
      if (!claims) {
        const first = (result as { errors?: { reason?: string; message?: string }[] }).errors?.[0];
        logRejection(first?.reason ?? "no_claims", first?.message ?? "");
      } else if (!azpAllowed(claims.azp, parties, allowMissingAzp)) {
        logRejection(
          "azp_not_allowed",
          `azp=${String(claims.azp)} allowMissing=${allowMissingAzp}`,
        );
      } else {
        subject = claims.sub;
      }
    } catch (error) {
      logRejection((error as { reason?: string }).reason ?? "thrown", String(error));
    }

    if (typeof subject !== "string" || subject.length === 0) {
      return fail(c, 401, "unauthorized", "Invalid session token");
    }
    c.set("authSubject", subject);
    const refused = await accessGate(c, subject);
    if (refused) return refused;
    await next();
  },
);
