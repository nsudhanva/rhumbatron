/**
 * Live model check through the AI Gateway: one tool-calling request per tier (3 free requests),
 * then one Vertex fallback request with OpenRouter forced to 429 (about $0.0004 of GCP credit).
 * Usage: bun run smoke:models
 * OpenRouter free models allow 50 requests per day on an account with under $10 of credit
 * purchases, so run this only when the model path changes. Prints metadata only, never content.
 */
import { complete, ModelCallError, TIER_MODELS } from "@rhumbatron/model-router";

const { OPENROUTER_API_KEY, CLOUDFLARE_ACCOUNT_ID, VERTEX_SERVICE_ACCOUNT } = process.env;
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

const config = {
  accountId: CLOUDFLARE_ACCOUNT_ID,
  gatewayId,
  apiKey: OPENROUTER_API_KEY,
  ...(VERTEX_SERVICE_ACCOUNT ? { vertexServiceAccount: VERTEX_SERVICE_ACCOUNT } : {}),
};

let failed = 0;
for (const tier of Object.keys(TIER_MODELS) as (keyof typeof TIER_MODELS)[]) {
  try {
    const result = await complete(config, {
      tier,
      maxOutputTokens: 2000,
      metadata: { source: "smoke-models", tier },
      messages: [{ role: "user", content: "Use the tool to read src/cart.ts." }],
      tools: [readFile],
    });
    const called = result.toolCalls[0]?.function.name === "read_file";
    if (!called) failed++;
    console.log(
      `${called ? "pass" : "FAIL"}  ${tier}  ${result.provider}/${result.model}  ${result.latencyMs}ms  in=${result.inputTokens} out=${result.outputTokens} cost=$${result.costUsd}`,
    );
  } catch (error) {
    failed++;
    const detail =
      error instanceof ModelCallError ? `${error.kind} ${error.message}` : String(error);
    console.log(`FAIL  ${tier}  ${detail.slice(0, 200)}`);
  }
}
if (VERTEX_SERVICE_ACCOUNT) {
  // Simulate an exhausted free pool so the call takes the paid Vertex path.
  const forceOpenRouter429 = (input: string | URL | Request, init?: RequestInit) =>
    String(input).includes("/openrouter/")
      ? Promise.resolve(
          Response.json({ error: { message: "simulated", code: 429 } }, { status: 429 }),
        )
      : fetch(input, init);
  try {
    const result = await complete(
      { ...config, fetch: forceOpenRouter429 },
      {
        tier: "haiku",
        maxOutputTokens: 500,
        metadata: { source: "smoke-models", tier: "haiku-vertex" },
        messages: [{ role: "user", content: "Use the tool to read src/cart.ts." }],
        tools: [readFile],
      },
    );
    const ok = result.provider === "google-vertex-ai" && result.toolCalls.length > 0;
    if (!ok) failed++;
    console.log(
      `${ok ? "pass" : "FAIL"}  fallback  ${result.provider}/${result.model}  ${result.latencyMs}ms  cost=$${result.costUsd.toFixed(6)}`,
    );
  } catch (error) {
    failed++;
    const detail =
      error instanceof ModelCallError ? `${error.kind} ${error.message}` : String(error);
    console.log(`FAIL  fallback  ${detail.slice(0, 200)}`);
  }
} else {
  console.log("skip  fallback  VERTEX_SERVICE_ACCOUNT not set");
}

process.exit(failed === 0 ? 0 : 1);
