import { ApiErrorBody } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { azpAllowed, claimsFrom, requireAuth } from "./auth.ts";

const env = {
  CLERK_SECRET_KEY: "test-placeholder-not-a-key",
  CLERK_AUTHORIZED_PARTIES: "https://dev.example",
};

const app = new Hono<{ Bindings: Env }>()
  .use("/v1/private/*", requireAuth)
  .get("/v1/private/thing", (c) => c.json({ ok: true }))
  .notFound((c) => c.json({ error: { code: "not_found", message: "Route not found" } }, 404));

const call = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers }, env as unknown as Env);

describe("requireAuth", () => {
  it("rejects a request without a session token", async () => {
    const res = await call("/v1/private/thing");
    expect(res.status).toBe(401);
    expect(ApiErrorBody.parse(await res.json()).error.code).toBe("unauthorized");
  });

  it("rejects a malformed session token with 401, not 500", async () => {
    const res = await call("/v1/private/thing", { authorization: "Bearer not-a-jwt" });
    expect(res.status).toBe(401);
  });

  it("does not guard routes outside its path", async () => {
    const res = await call("/somewhere-else");
    expect(res.status).toBe(404);
  });
});

describe("azpAllowed", () => {
  const parties = ["https://dev.example", "http://localhost:5173"];

  it("accepts an allowed origin", () => {
    expect(azpAllowed("https://dev.example", parties, false)).toBe(true);
  });

  it("rejects an unknown origin even when missing azp is allowed", () => {
    expect(azpAllowed("https://evil.example", parties, true)).toBe(false);
  });

  it("rejects a missing azp in strict mode", () => {
    expect(azpAllowed(undefined, parties, false)).toBe(false);
  });

  it("accepts a missing azp only when explicitly allowed", () => {
    expect(azpAllowed(undefined, parties, true)).toBe(true);
  });
});

describe("claimsFrom", () => {
  it("reads a bare JWT payload (current runtime shape)", () => {
    expect(claimsFrom({ sub: "user_1", sid: "sess_1" })?.sub).toBe("user_1");
  });

  it("reads a { data } result (documented type shape)", () => {
    expect(claimsFrom({ data: { sub: "user_2" } })?.sub).toBe("user_2");
  });

  it("returns nothing for an { errors } result", () => {
    expect(claimsFrom({ errors: [new Error("bad")] })).toBeUndefined();
  });
});
