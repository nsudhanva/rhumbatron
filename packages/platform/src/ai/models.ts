import { log } from "../log.ts";

/**
 * Small-model inference. It has the `run(model, input)` surface the code calls:
 * - `@cf/baai/bge-small-en-v1.5`: 384-dimension embeddings from a llama.cpp server.
 * - `@cf/baai/bge-reranker-base`: reranking from a second llama.cpp server.
 * - `@cf/cloudflare/clef` and `clef-flash`: bounded choice questions, answered by Claude Haiku
 *   with a forced tool call. The caller abstains on any answer it cannot parse.
 */

export type ModelsConfig = {
  embedUrl: string;
  rerankUrl: string;
  anthropicBaseUrl: string;
  anthropicApiKey: string;
  anthropicWorkspaceId?: string;
  decisionModel: string;
};

type ClefQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };

export class SmallModels {
  constructor(private readonly config: ModelsConfig) {}

  async run(model: string, input: Record<string, unknown>): Promise<unknown> {
    if (model.endsWith("bge-small-en-v1.5")) return this.embed(input.text as string | string[]);
    if (model.endsWith("bge-reranker-base"))
      return this.rerank(input.query as string, input.contexts as { text: string }[]);
    if (model.endsWith("/clef") || model.endsWith("/clef-flash"))
      return this.decide(input.state, input.questions as Record<string, ClefQuestion>);
    throw new Error(`Model ${model} is not available on this platform`);
  }

  private async embed(
    text: string | string[],
  ): Promise<{ shape: [number, number]; data: number[][] }> {
    const inputs = Array.isArray(text) ? text : [text];
    const response = await fetch(`${this.config.embedUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: inputs }),
    });
    if (!response.ok) throw new Error(`embedding server returned ${response.status}`);
    const body = (await response.json()) as { data: { index: number; embedding: number[] }[] };
    const data = body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return { shape: [data.length, data[0]?.length ?? 0], data };
  }

  private async rerank(
    query: string,
    contexts: { text: string }[],
  ): Promise<{ response: { id: number; score: number }[] }> {
    const response = await fetch(`${this.config.rerankUrl}/v1/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, documents: contexts.map((c) => c.text) }),
    });
    if (!response.ok) throw new Error(`rerank server returned ${response.status}`);
    const body = (await response.json()) as {
      results: { index: number; relevance_score: number }[];
    };
    return { response: body.results.map((r) => ({ id: r.index, score: r.relevance_score })) };
  }

  private async decide(state: unknown, questions: Record<string, ClefQuestion>): Promise<unknown> {
    if (!this.config.anthropicApiKey) return { answers: {} };
    const properties: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(questions)) {
      const options = Object.keys(q.criteria);
      properties[id] = {
        type: "object",
        description: q.instructions,
        properties: {
          choice: { type: "string", enum: options },
          probabilities: {
            type: "object",
            description: "Your probability for each option. The values sum to 1.",
            properties: Object.fromEntries(
              options.map((o) => [o, { type: "number", minimum: 0, maximum: 1 }]),
            ),
            required: options,
          },
        },
        required: ["choice", "probabilities"],
      };
    }
    try {
      const response = await fetch(`${this.config.anthropicBaseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.anthropicApiKey,
          "anthropic-version": "2023-06-01",
          ...(this.config.anthropicWorkspaceId
            ? { "anthropic-workspace-id": this.config.anthropicWorkspaceId }
            : {}),
        },
        body: JSON.stringify({
          model: this.config.decisionModel,
          max_tokens: 1024,
          system:
            "You answer bounded routing questions about a software project. Answer each question with one option and calibrated probabilities. Say nothing else.",
          messages: [
            { role: "user", content: `State:\n${JSON.stringify(state).slice(0, 12_000)}` },
          ],
          tools: [
            {
              name: "answer",
              description: "Record the answers.",
              input_schema: { type: "object", properties, required: Object.keys(questions) },
            },
          ],
          tool_choice: { type: "tool", name: "answer" },
        }),
      });
      if (!response.ok) throw new Error(`decision model returned ${response.status}`);
      const body = (await response.json()) as { content: { type: string; input?: unknown }[] };
      const answers = body.content.find((c) => c.type === "tool_use")?.input ?? {};
      return { answers };
    } catch (error) {
      log.warn("models.decide_failed", { error: String(error).slice(0, 200) });
      return { answers: {} };
    }
  }
}
