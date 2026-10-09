/**
 * Live model check through the AI Gateway: one tool-calling request per tier (3 requests).
 * Usage: bun run smoke:models
 * OpenRouter free models allow 50 requests per day on an account with under $10 of credit
 * purchases, so run this only when the model path changes. Prints metadata only, never content.
 */
import { complete, ModelCallError, TIER_MODELS } from "@rhumbatron/model-router";

const { OPENROUTER_API_KEY, CLOUDFLARE_ACCOUNT_ID } = process.env;
const gatewayId = `rhumbatron-models-${process.argv[2] ?? "dev"}`;
if (!OPENROUTER_API_KEY || !CLOUDFLARE_ACCOUNT_ID) {
  console.error("OPENROUTER_API_KEY and CLOUDFLARE_ACCOUNT_ID are required (see package.json).");
  process.exit(2);
}

const readFile = {
  type: "function" as const,
  function: {
    name: "read_file",
    description: "Read one file from the workspace.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

let failed = 0;
for (const tier of Object.keys(TIER_MODELS) as (keyof typeof TIER_MODELS)[]) {
  try {
    const result = await complete(
      { accountId: CLOUDFLARE_ACCOUNT_ID, gatewayId, apiKey: OPENROUTER_API_KEY },
      {
        tier,
        maxOutputTokens: 2000,
        metadata: { source: "smoke-models", tier },
        messages: [{ role: "user", content: "Use the tool to read src/cart.ts." }],
        tools: [readFile],
      },
    );
    const called = result.toolCalls[0]?.function.name === "read_file";
    if (!called) failed++;
    console.log(
      `${called ? "pass" : "FAIL"}  ${tier}  ${result.model}  ${result.latencyMs}ms  in=${result.inputTokens} out=${result.outputTokens} cost=$${result.costUsd}`,
    );
  } catch (error) {
    failed++;
    const detail =
      error instanceof ModelCallError ? `${error.kind} ${error.message}` : String(error);
    console.log(`FAIL  ${tier}  ${detail.slice(0, 200)}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
