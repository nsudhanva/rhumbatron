import { ApiErrorBody, apiData } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorBody, respond, validate } from "./http.ts";

const Item = z.object({ name: z.string().min(1) });

const app = new Hono()
  .post("/items", validate("json", Item), (c) =>
    respond(c, apiData(Item), { data: c.req.valid("json") }, 201),
  )
  // Deliberately breaks its own response contract.
  .get("/broken", (c) => respond(c, apiData(Item), { data: { name: "" } }))
  .onError((_err, c) => c.json(errorBody("internal", "Internal error"), 500));

describe("API contract wrapper", () => {
  it("returns parsed data for valid input", async () => {
    const res = await app.request("/items", {
      method: "POST",
      body: JSON.stringify({ name: "wishlist" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { name: "wishlist" } });
  });

  it("rejects invalid input with 400 and the standard error shape", async () => {
    const res = await app.request("/items", {
      method: "POST",
      body: JSON.stringify({ name: "" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = ApiErrorBody.parse(await res.json());
    expect(body.error.code).toBe("invalid_request");
  });

  it("turns a response contract violation into a 500 without leaking the payload", async () => {
    const res = await app.request("/broken");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal", message: "Internal error" } });
  });
});
