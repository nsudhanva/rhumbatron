/**
 * Temporary K2 adapter (ADR 0006). Provider 5.27 has no K2 resource.
 * Invoked only by terraform_data.k2_streams. Idempotent: creates missing streams and
 * subscriptions and fixes retention. It never deletes streams (a replace would lose data).
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
