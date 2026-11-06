import { log } from "../../../packages/platform/src/log.ts";
import type { ObjectBucket } from "../../../packages/platform/src/objects/bucket.ts";

/**
 * Object expiry for the evidence bucket, once a day. `app-previews/` (Candidate preview bundles)
 * and `tmp/` live 7 days; the `events/` archive lives 365 days. `evidence/` and app bundles stay
 * until their Project is deleted.
 */
const RULES = [
  { prefix: "app-previews/", days: 7 },
  { prefix: "tmp/", days: 7 },
  { prefix: "events/", days: 365 },
];
const DAY_MS = 86_400_000;

async function expireObjects(bucket: ObjectBucket, now = Date.now()): Promise<number> {
  let deleted = 0;
  for (const rule of RULES) {
    const cutoff = now - rule.days * DAY_MS;
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: rule.prefix, ...(cursor ? { cursor } : {}) });
      const old = page.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
      if (old.length) await bucket.delete(old);
      deleted += old.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  if (deleted) log.info("objects.expired", { deleted });
  return deleted;
}

/** Runs the expiry now and then every 24 hours. */
export function scheduleExpiry(bucket: ObjectBucket, signal: AbortSignal): void {
  const run = () =>
    expireObjects(bucket).catch((error) =>
      log.error("objects.expiry_failed", { error: String(error).slice(0, 300) }),
    );
  void run();
  const timer = setInterval(run, DAY_MS);
  signal.addEventListener("abort", () => clearInterval(timer));
}
