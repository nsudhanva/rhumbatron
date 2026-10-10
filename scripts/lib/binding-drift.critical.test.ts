import { describe, expect, it } from "vitest";
import {
  hclBindingNames,
  hclBindingsExpr,
  hclBlock,
  hclCapBindingNames,
  parseJsonc,
  stripHclComments,
  wranglerBindingNames,
} from "./binding-drift.ts";

describe("wranglerBindingNames", () => {
  it("reads every kind, ignores comments, trailing commas, and consumer-only queues", () => {
    const cfg = parseJsonc(`{
      // comment with "quotes" and { braces
      "vars": { "A": "http://x//y", },
      "d1_databases": [{ "binding": "DB", }],
      "queues": { "producers": [{ "binding": "Q", "queue": "q" }], "consumers": [{ "queue": "z" }] },
      "durable_objects": { "bindings": [{ "name": "DO", "class_name": "X" }] },
      "workflows": [{ "binding": "WF", "name": "wf" }],
      "ai": { "binding": "AI" },
      "worker_loaders": [{ "binding": "LOADER" }], /* block */
      "containers": [{ "class_name": "S" }],
    }`);
    expect(wranglerBindingNames(cfg)).toEqual(["A", "AI", "DB", "DO", "LOADER", "Q", "WF"]);
  });
});

describe("terraform binding extraction", () => {
  const tf = stripHclComments(`
locals {
  cap_bindings = {
    sandbox = { type = "plain_text", name = "SANDBOX_SECONDS", text = "1" }
  }
}
module "x_worker" {
  bindings = concat(
    [
      { type = "plain_text", name = "ENVIRONMENT", text = "a (b" },
      module.state.bindings.DB,
      { type = "queue", name = "Q", queue_name = "ignored" },
      # { type = "plain_text", name = "COMMENTED" },
    ],
    local.cap_bindings.sandbox,
  )
  other = { name = "NOT_A_BINDING" }
}`);
  it("collects inline, module.state and cap_bindings names from the bindings list only", () => {
    const block = hclBlock(tf, "module", "x_worker") as string;
    const expr = hclBindingsExpr(block) as string;
    expect(hclBindingNames(expr, hclCapBindingNames(tf))).toEqual([
      "DB",
      "ENVIRONMENT",
      "Q",
      "SANDBOX_SECONDS",
    ]);
  });
});
