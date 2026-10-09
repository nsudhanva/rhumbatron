import { z } from "zod";

/**
 * Bounded decision models (AGENTS.md 31.2, 23). Business code depends only on `DecisionModel`.
 * A Jev adapter (P5-08) implements the same interface; Clef is Jev-compatible, so only the endpoint differs.
 * Never logs `state`, which can hold task or repository text.
 */

// Source: https://developers.cloudflare.com/workers-ai/models/clef-flash/ and .../clef/
export const CLEF_MODELS = {
  "clef-flash": "@cf/cloudflare/clef-flash",
  clef: "@cf/cloudflare/clef",
} as const;

export type DecisionQuestion = { id: string; prompt: string; options: readonly string[] };

export type DecisionRequest = {
  state: string | Record<string, unknown>;
  questions: readonly DecisionQuestion[];
  model: keyof typeof CLEF_MODELS;
};

export type DecisionAnswer = {
  questionId: string;
  choice: string | null;
  probabilities: Record<string, number>;
  abstained: boolean;
};

export interface DecisionModel {
  decide(req: DecisionRequest): Promise<DecisionAnswer[]>;
}

const ChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
});
const ResponseSchema = z.object({ answers: z.record(z.string(), z.unknown()) });

type WorkersAiLike = { run(model: string, input: unknown): Promise<unknown> };

export class WorkersAiDecisionModel implements DecisionModel {
  constructor(
    private readonly opts: {
      ai: WorkersAiLike;
      abstainBelow: number;
      allowCall?: () => Promise<boolean>;
    },
  ) {}

  async decide(req: DecisionRequest): Promise<DecisionAnswer[]> {
    const abstainAll = () => req.questions.map((q) => this.abstain(q.id));
    if (this.opts.allowCall && !(await this.opts.allowCall())) return abstainAll();

    const questions = Object.fromEntries(
      req.questions.map((q) => [
        q.id,
        {
          type: "choice",
          instructions: q.prompt,
          criteria: Object.fromEntries(q.options.map((o) => [o, o])),
        },
      ]),
    );
    const raw = await this.opts.ai.run(CLEF_MODELS[req.model], {
      model: req.model,
      state: req.state,
      questions,
    });

    const parsed = ResponseSchema.safeParse(raw);
    if (!parsed.success) return abstainAll();
    return req.questions.map((q) => this.answer(q, parsed.data.answers[q.id]));
  }

  private answer(q: DecisionQuestion, raw: unknown): DecisionAnswer {
    const parsed = ChoiceAnswerSchema.safeParse(raw);
    if (!parsed.success) return this.abstain(q.id);
    const { choice, probabilities } = parsed.data;
    const p = probabilities[choice];
    if (!q.options.includes(choice) || p === undefined || p < this.opts.abstainBelow) {
      return { questionId: q.id, choice: null, probabilities, abstained: true };
    }
    return { questionId: q.id, choice, probabilities, abstained: false };
  }

  private abstain(questionId: string): DecisionAnswer {
    return { questionId, choice: null, probabilities: {}, abstained: true };
  }
}
