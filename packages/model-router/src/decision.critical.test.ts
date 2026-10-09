import { describe, expect, it, vi } from "vitest";
import { type DecisionRequest, WorkersAiDecisionModel } from "./decision.ts";

const req: DecisionRequest = {
  state: "event",
  model: "clef-flash",
  questions: [{ id: "wake", prompt: "Wake agent?", options: ["yes", "no"] }],
};
const reply = (choice: string, yes: number) => ({
  answers: { wake: { type: "choice", choice, probabilities: { yes, no: 1 - yes } } },
});

describe("WorkersAiDecisionModel", () => {
  it("chooses a confident answer", async () => {
    const run = vi.fn().mockResolvedValue(reply("yes", 0.9));
    const [a] = await new WorkersAiDecisionModel({ ai: { run }, abstainBelow: 0.7 }).decide(req);
    expect(a?.choice).toBe("yes");
    expect(run.mock.calls[0]?.[0]).toBe("@cf/cloudflare/clef-flash");
  });

  it("abstains below the threshold", async () => {
    const ai = { run: async () => reply("yes", 0.55) };
    const [a] = await new WorkersAiDecisionModel({ ai, abstainBelow: 0.7 }).decide(req);
    expect(a).toMatchObject({ choice: null, abstained: true });
  });

  it("does not call the model when the cap is reached", async () => {
    const run = vi.fn();
    const m = new WorkersAiDecisionModel({
      ai: { run },
      abstainBelow: 0.7,
      allowCall: async () => false,
    });
    expect((await m.decide(req))[0]?.abstained).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("abstains on malformed or unknown-option responses", async () => {
    for (const bad of [null, { answers: {} }, reply("maybe", 0.99)]) {
      const ai = { run: async () => bad };
      const [a] = await new WorkersAiDecisionModel({ ai, abstainBelow: 0.7 }).decide(req);
      expect(a?.abstained).toBe(true);
    }
  });
});
