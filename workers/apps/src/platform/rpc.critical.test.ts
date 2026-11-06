import { describe, expect, it } from "vitest";
import { handleRpc } from "./rpc.ts";

// The internal RPC listener is a security boundary: only a holder of INTERNAL_TOKEN can build,
// wipe, or read app data, and only the listed methods are callable.

const calls: unknown[][] = [];
const stub = {
  build: async (...args: unknown[]) => {
    calls.push(args);
    return { ok: true };
  },
  wipe: async () => "must not be callable",
};
const exports = { AppBuilder: () => stub, AppChecker: () => stub, AppData: () => stub };

const post = (path: string, init: { token?: string; body?: string; props?: string } = {}) =>
  new Request(`http://apps:8789${path}`, {
    method: "POST",
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.props ? { "x-rpc-props": init.props } : {}),
    },
    body: init.body ?? "[]",
  });

describe("handleRpc", () => {
  it("fails closed without a configured token", async () => {
    const res = await handleRpc(post("/rpc/AppBuilder/build", { token: "" }), "", exports);
    expect(res.status).toBe(503);
  });

  it("rejects a missing or wrong token", async () => {
    expect((await handleRpc(post("/rpc/AppBuilder/build"), "secret", exports)).status).toBe(401);
    const wrong = post("/rpc/AppBuilder/build", { token: "secreT" });
    expect((await handleRpc(wrong, "secret", exports)).status).toBe(401);
  });

  it("calls only listed methods", async () => {
    const res = await handleRpc(post("/rpc/AppBuilder/wipe", { token: "s" }), "s", exports);
    expect(res.status).toBe(404);
  });

  it("needs a store name for AppData", async () => {
    const res = await handleRpc(
      post("/rpc/AppData/get", { token: "s", body: '["k"]' }),
      "s",
      exports,
    );
    expect(res.status).toBe(400);
  });

  it("passes the argument array and returns the JSON result", async () => {
    const res = await handleRpc(
      post("/rpc/AppBuilder/build", { token: "s", body: '[{"a":1},2]' }),
      "s",
      exports,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls.at(-1)).toEqual([{ a: 1 }, 2]);
  });
});
