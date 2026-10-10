import { describe, expect, it } from "vitest";
import { type DeploymentRow, selectDeployment } from "./pointer.ts";

const P = "proj_1111";
const C1 = "a".repeat(40);
const C2 = "b".repeat(40);

const row = (patch: Partial<DeploymentRow>): DeploymentRow => ({
  project_id: P,
  slug: "acme",
  channel: "production",
  commit_sha: C1,
  generation: 0,
  bundle_key: `apps/${P}/${C1}`,
  status: "ready",
  failure_reason: null,
  ...patch,
});
const prod = { kind: "production", label: "acme" } as const;
const preview = { kind: "preview", label: "acme", previewId: "0123abcd" } as const;

describe("selectDeployment", () => {
  it("serves the production pointer with a stable loader id", () => {
    expect(selectDeployment(prod, [row({})])).toEqual({
      kind: "serve",
      projectId: P,
      commit: C1,
      bundleKey: `apps/${P}/${C1}`,
      loaderId: `${P}@${C1}`,
      storeName: P,
    });
  });

  it("serves a preview from its own channel, with its own loader id and store", () => {
    const rows = [
      row({}),
      row({ channel: "preview:0123abcd", commit_sha: C2, bundle_key: `app-previews/${P}/${C2}` }),
    ];
    expect(selectDeployment(preview, rows)).toMatchObject({
      kind: "serve",
      commit: C2,
      loaderId: `${P}@${C2}:preview`,
      storeName: `${P}#preview:0123abcd`,
    });
  });

  it("keeps serving the last good bundle while a build runs or after it fails", () => {
    expect(selectDeployment(prod, [row({ status: "building" })]).kind).toBe("serve");
    expect(selectDeployment(prod, [row({ status: "failed", failure_reason: "x" })]).kind).toBe(
      "serve",
    );
  });

  it("shows building or failed only when no bundle exists yet", () => {
    const none = { bundle_key: null };
    expect(selectDeployment(prod, [row({ ...none, status: "building" })])).toEqual({
      kind: "building",
    });
    expect(
      selectDeployment(prod, [row({ ...none, status: "failed", failure_reason: "auth" })]),
    ).toEqual({ kind: "failed", reason: "auth" });
  });

  it("answers removed for the app and all its previews", () => {
    const rows = [
      row({ status: "removed" }),
      row({ channel: "preview:0123abcd", commit_sha: C2, bundle_key: `app-previews/${P}/${C2}` }),
    ];
    expect(selectDeployment(prod, rows)).toEqual({ kind: "removed" });
    expect(selectDeployment(preview, rows)).toEqual({ kind: "removed" });
  });

  it("finds nothing for unknown hosts, other labels, reserved and invalid hosts", () => {
    expect(selectDeployment(prod, [])).toEqual({ kind: "not_found" });
    expect(selectDeployment(prod, [row({ slug: "other" })])).toEqual({ kind: "not_found" });
    expect(selectDeployment(preview, [row({})])).toEqual({ kind: "not_found" });
    expect(selectDeployment({ kind: "reserved", label: "api" }, [row({ slug: "api" })])).toEqual({
      kind: "not_found",
    });
    expect(selectDeployment({ kind: "invalid" }, [row({})])).toEqual({ kind: "not_found" });
  });
});
