// Poison command bound (AGENTS.md sections 20, 42.7, P13-10). Consumers retry every failure
// (workers/agents/src/queue-poison.critical.test.ts); the Queue consumer settings decide when a
// poison command stops and moves to the dead-letter Queue. A consumer without a dead-letter Queue
// or with unbounded retries would retry poison work forever.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

/** Every `cloudflare_queue_consumer` block in a Terraform file, by resource name. */
function consumerBlocks(tf: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const header = /resource\s+"cloudflare_queue_consumer"\s+"([\w-]+)"\s*\{/g;
  for (const match of tf.matchAll(header)) {
    let depth = 1;
    let i = (match.index ?? 0) + match[0].length;
    while (depth > 0 && i < tf.length) {
      if (tf[i] === "{") depth++;
      else if (tf[i] === "}") depth--;
      i++;
    }
    blocks.set(match[1] ?? "", tf.slice(match.index, i));
  }
  return blocks;
}

describe("Queue consumers send poison commands to the dead-letter Queue", () => {
  const dev = consumerBlocks(read("infrastructure/terraform/envs/dev/main.tf"));

  it("finds the dev consumers", () => {
    expect([...dev.keys()].sort()).toEqual(
      expect.arrayContaining(["agent_wakeups", "integration"]),
    );
  });

  for (const [name, block] of dev) {
    it(`dev consumer ${name} has a dead-letter Queue and bounded retries`, () => {
      expect(block).toMatch(/dead_letter_queue\s*=\s*module\.async\.queues\["dead-letter"\]\.name/);
      const retries = Number(/max_retries\s*=\s*(\d+)/.exec(block)?.[1] ?? Number.NaN);
      expect(retries).toBeGreaterThanOrEqual(1);
      expect(retries).toBeLessThanOrEqual(5);
    });
  }

  for (const worker of ["agents", "integration"]) {
    it(`local ${worker} consumer matches: bounded retries and a dead-letter Queue`, () => {
      const config = read(`workers/${worker}/wrangler.jsonc`);
      expect(config).toMatch(/"dead_letter_queue":\s*"rhumbatron-dead-letter-local"/);
      expect(config).toMatch(/"max_retries":\s*[1-5]\b/);
    });
  }
});
