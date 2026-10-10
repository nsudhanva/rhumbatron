import { AnyCommandEnvelope } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import {
  releaseCommand,
  requestWorkflowStart,
  startWorkflow,
  verificationCommand,
  workflowStartFor,
} from "./workflow-commands.ts";

const route = { projectId: "proj_acme", changeId: "chg_1" };

/** A Workflow binding that, like Cloudflare's, refuses a second instance with the same ID. */
function fakeWorkflow() {
  const instances = new Map<string, unknown>();
  let creates = 0;
  return {
    instances,
    creates: () => creates,
    binding: {
      create: async ({ id, params }: { id: string; params: unknown }) => {
        creates += 1;
        if (instances.has(id)) throw new Error("instance.already_exists");
        instances.set(id, params);
        return { id };
      },
      get: async (id: string) => {
        if (!instances.has(id)) throw new Error("instance.not_found");
        return { id };
      },
    },
  };
}

function harness(queue?: { send: (body: unknown) => Promise<void> }) {
  const candidate = fakeWorkflow();
  const release = fakeWorkflow();
  const env = {
    CANDIDATE_WORKFLOW: candidate.binding,
    RELEASE_WORKFLOW: release.binding,
    ...(queue ? { VERIFICATION_COMMANDS: queue, RELEASE_COMMANDS: queue } : {}),
  } as unknown as Env;
  return { env, candidate, release };
}

describe("workflow start commands (section 20, HOM-202)", () => {
  it("maps a command to its Workflow with the idempotency key as the instance ID", () => {
    const verify = verificationCommand("cand_abc123", route, "2026-10-09T10:00:00.000Z");
    const rel = releaseCommand("rel_proj_acme_1842", route, "2026-10-09T10:00:00.000Z");
    expect(AnyCommandEnvelope.safeParse(verify).success).toBe(true);
    expect(AnyCommandEnvelope.safeParse(rel).success).toBe(true);
    expect(workflowStartFor(verify)).toEqual({
      workflow: "candidate",
      instanceId: "cand_abc123",
      params: { candidateId: "cand_abc123" },
    });
    expect(workflowStartFor(rel)).toEqual({
      workflow: "release",
      instanceId: "rel_proj_acme_1842",
      params: { releaseId: "rel_proj_acme_1842" },
    });
  });

  it("keeps the command ID stable across resends of the same start", () => {
    const a = verificationCommand("cand_abc123", route, "2026-10-09T10:00:00.000Z");
    const b = verificationCommand("cand_abc123", route, "2026-10-09T11:00:00.000Z");
    expect(a.commandId).toBe(b.commandId);
    expect(releaseCommand("rel_proj_acme_1842", route).commandId).not.toBe(a.commandId);
  });

  it("refuses other commands and malformed keys", () => {
    expect(workflowStartFor({ commandType: "change.dispatch", payload: {} })).toBeNull();
    expect(
      workflowStartFor({ commandType: "verification.start", payload: { candidateId: "x" } }),
    ).toBeNull();
    expect(
      workflowStartFor({ commandType: "release.start", payload: { releaseId: "../evil" } }),
    ).toBeNull();
  });

  it("starts one instance however often the command is delivered", async () => {
    const h = harness();
    const start = workflowStartFor(verificationCommand("cand_abc123", route));
    if (!start) throw new Error("expected a start");
    expect(await startWorkflow(h.env, start)).toBe("created");
    expect(await startWorkflow(h.env, start)).toBe("existing");
    expect(await startWorkflow(h.env, start)).toBe("existing");
    expect([...h.candidate.instances.keys()]).toEqual(["cand_abc123"]);
    expect(h.release.instances.size).toBe(0);
  });

  it("queues the command and does not start the Workflow inline", async () => {
    const sent: unknown[] = [];
    const h = harness({ send: async (body) => void sent.push(body) });
    const command = releaseCommand("rel_proj_acme_1842", route);
    expect(await requestWorkflowStart(h.env, command)).toBe("queued");
    expect(sent).toEqual([command]);
    expect(h.release.creates()).toBe(0);
  });

  it("falls back to a direct start only when the send fails, and stays idempotent", async () => {
    const h = harness({
      send: async () => {
        throw new Error("queue unavailable");
      },
    });
    const command = releaseCommand("rel_proj_acme_1842", route);
    expect(await requestWorkflowStart(h.env, command)).toBe("created");
    // The send failed ambiguously and the message still arrived: the consumer finds the instance.
    const start = workflowStartFor(command);
    if (!start) throw new Error("expected a start");
    expect(await startWorkflow(h.env, start)).toBe("existing");
    expect(h.release.instances.size).toBe(1);
  });

  it("rethrows a create failure that left no instance, so the Queue retries", async () => {
    const h = harness();
    const env = {
      ...h.env,
      CANDIDATE_WORKFLOW: {
        create: async () => {
          throw new Error("workflows unavailable");
        },
        get: async () => {
          throw new Error("instance.not_found");
        },
      },
    } as unknown as Env;
    const start = workflowStartFor(verificationCommand("cand_abc123", route));
    if (!start) throw new Error("expected a start");
    await expect(startWorkflow(env, start)).rejects.toThrow("workflows unavailable");
  });
});
