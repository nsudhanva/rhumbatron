/**
 * Live model check through the AI Gateway's Anthropic endpoint (ADR 0021). Usage:
 *   bun run smoke:models [prod]
 * Four small requests, well under one US cent in total:
 * 1. A bogus `anthropic-workspace-id` must be rejected by Anthropic: proves the gateway forwards
 *    the header (a rejected request is not billed).
 * 2. One tool-calling request per tier: haiku, sonnet, and opus (Sonnet unless ALLOW_OPUS=true).
 * 3. The same Haiku request twice with a system prompt above the 512-token cache minimum: the
 *    second must read the cache.
 * Prints metadata only (models, tokens, cost), never the key or any content.
 */
import { complete, ModelCallError, opusAllowed, TIER_MODELS } from "@rhumbatron/model-router";

const { ANTHROPIC_API_KEY, ANTHROPIC_WORKSPACE_ID, CLOUDFLARE_ACCOUNT_ID, ALLOW_OPUS } =
  process.env;
const env = process.argv[2] ?? "prod";
if (env !== "prod") {
  console.error("Usage: bun run smoke:models [prod]");
  process.exit(2);
}
if (!ANTHROPIC_API_KEY || !ANTHROPIC_WORKSPACE_ID || !CLOUDFLARE_ACCOUNT_ID) {
  console.error(
    "ANTHROPIC_API_KEY, ANTHROPIC_WORKSPACE_ID and CLOUDFLARE_ACCOUNT_ID are required (see package.json).",
  );
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
  gatewayId: `rhumbatron-models-${env}`,
  apiKey: ANTHROPIC_API_KEY,
  workspaceId: ANTHROPIC_WORKSPACE_ID,
  allowOpus: opusAllowed(ALLOW_OPUS),
  timeoutMs: 60_000,
};

let failed = 0;
let spent = 0;
const detail = (error: unknown) =>
  (error instanceof ModelCallError
    ? `${error.kind} ${error.status ?? ""} ${error.message}`
    : String(error)
  ).slice(0, 200);

// 1. Header pass-through: Anthropic, not the gateway, must reject an unknown workspace.
try {
  await complete(
    { ...config, workspaceId: "wrkspc_00000000000000000000000000" },
    { tier: "haiku", maxOutputTokens: 16, messages: [{ role: "user", content: "ok" }] },
  );
  failed++;
  console.log("FAIL  workspace header  a bogus workspace id was accepted");
} catch (error) {
  const text = detail(error);
  const forwarded = /workspace/i.test(text);
  if (!forwarded) failed++;
  console.log(`${forwarded ? "pass" : "FAIL"}  workspace header  rejected: ${text}`);
}

// 2. One tool call per tier.
for (const tier of Object.keys(TIER_MODELS) as (keyof typeof TIER_MODELS)[]) {
  try {
    const result = await complete(config, {
      tier,
      maxOutputTokens: tier === "haiku" ? 512 : 1024,
      metadata: { source: "smoke-models", tier },
      messages: [{ role: "user", content: "Use the tool to read src/cart.ts." }],
      tools: [readFile],
    });
    spent += result.costUsd;
    const called = result.toolCalls[0]?.function.name === "read_file";
    if (!called) failed++;
    console.log(
      `${called ? "pass" : "FAIL"}  ${tier}  ${result.model}${result.requestedTier ? ` (requested ${result.requestedTier})` : ""}  ${result.latencyMs}ms  in=${result.inputTokens} out=${result.outputTokens} cost=$${result.costUsd.toFixed(6)} log=${result.gatewayLogId ?? "-"}`,
    );
  } catch (error) {
    failed++;
    console.log(`FAIL  ${tier}  ${detail(error)}`);
  }
}

// 3. Prompt caching: a stable system prompt above the 512-token minimum, sent twice.
const stable = Array.from(
  { length: 60 },
  (_, i) =>
    `Rule ${i + 1}: keep each answer short, factual, and limited to the file the user names.`,
).join("\n");
const cached: number[] = [];
for (let i = 0; i < 2; i++) {
  try {
    const result = await complete(config, {
      tier: "haiku",
      maxOutputTokens: 16,
      metadata: { source: "smoke-models", tier: "haiku-cache" },
      messages: [
        { role: "system", content: stable },
        { role: "user", content: "Reply with: ok" },
      ],
    });
    spent += result.costUsd;
    cached.push(result.cacheReadTokens);
    console.log(
      `info  cache ${i + 1}  write=${result.cacheWriteTokens} read=${result.cacheReadTokens} cost=$${result.costUsd.toFixed(6)}`,
    );
  } catch (error) {
    failed++;
    console.log(`FAIL  cache ${i + 1}  ${detail(error)}`);
  }
}
const hit = (cached[1] ?? 0) > 0;
if (!hit) failed++;
console.log(`${hit ? "pass" : "FAIL"}  prompt cache  second call read ${cached[1] ?? 0} tokens`);

console.log(`total cost $${spent.toFixed(6)}`);
process.exit(failed === 0 ? 0 : 1);
