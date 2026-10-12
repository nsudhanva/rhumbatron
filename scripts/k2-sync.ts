/**
 * K2 adapter (ADR 0006). Provider 5.27 has no K2 resource.
 * Invoked only by terraform_data.k2_streams. Idempotent: creates missing streams and
 * subscriptions and fixes retention. It never deletes streams (a replace would lose data).
 * `K2_MODE=destroy` (terraform_data.k2_streams_teardown, a real environment destroy only) deletes
 * exactly the named streams and refuses any prod stream.
 */
import { assertInvokedByTerraform, cfApi, requiredEnv } from "./lib/cloudflare-api.ts";

assertInvokedByTerraform("k2-sync");

type K2Config = { streams: { name: string; retention_seconds: number }[]; subscriptions: string[] };
type Stream = { id: string; name: string; retention_seconds: number };

const token = requiredEnv("CLOUDFLARE_API_TOKEN");
const accountId = requiredEnv("K2_ACCOUNT_ID");
const config = JSON.parse(requiredEnv("K2_CONFIG")) as K2Config;
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/k2/streams`;

const existing = await cfApi<Stream[]>(token, `${base}?per_page=100`);
const byName = new Map(existing.map((s) => [s.name.toLowerCase(), s]));

if (process.env.K2_MODE === "destroy") {
  if (config.streams.some((d) => d.name.toLowerCase().endsWith("_prod"))) {
    console.error("K2 destroy refuses prod streams. Nothing was deleted.");
    process.exit(1);
  }
  for (const desired of config.streams) {
    const stream = byName.get(desired.name.toLowerCase());
    if (!stream) continue;
    await cfApi(token, `${base}/${stream.id}`, { method: "DELETE" });
    console.log(`deleted stream ${desired.name}`);
  }
  console.log(`K2 destroy done: ${config.streams.length} streams checked.`);
  process.exit(0);
}

// K2 beta allows 20 streams per account, shared by prod and other projects (ADR 0017).
// Refuse before creating anything, so a full account never ends with a partial stream set.
const ACCOUNT_STREAM_LIMIT = 20;
const missing = config.streams.filter((d) => !byName.has(d.name.toLowerCase()));
if (existing.length + missing.length > ACCOUNT_STREAM_LIMIT) {
  console.error(
    `K2 account limit: ${existing.length} streams exist and ${missing.length} are missing; ` +
      `the account allows ${ACCOUNT_STREAM_LIMIT}. Nothing was created.`,
  );
  process.exit(1);
}

for (const desired of config.streams) {
  let stream = byName.get(desired.name.toLowerCase());
  if (!stream) {
    stream = await cfApi<Stream>(token, base, {
      method: "POST",
      body: JSON.stringify({
        name: desired.name,
        retention_seconds: desired.retention_seconds,
        worker_binding: { enabled: true },
        http: { enabled: true, authentication: true },
      }),
    });
    console.log(`created stream ${desired.name}`);
  } else if (stream.retention_seconds !== desired.retention_seconds) {
    await cfApi(token, `${base}/${stream.id}`, {
      method: "PATCH",
      body: JSON.stringify({ retention_seconds: desired.retention_seconds }),
    });
    console.log(`updated retention on ${desired.name}`);
  }

  // Subscriptions are immutable and idempotent by name; repeating a create returns the same ID.
  for (const name of config.subscriptions) {
    await cfApi(token, `https://${stream.id}.k2.cloudflarestorage.com/subscriptions`, {
      method: "POST",
      body: JSON.stringify({ name, start_at: { type: "earliest" } }),
    });
  }
}

console.log(
  `K2 in sync: ${config.streams.length} streams x ${config.subscriptions.length} subscriptions.`,
);
