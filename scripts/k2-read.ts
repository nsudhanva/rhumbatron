/**
 * Read-only external data source for Terraform (ADR 0006). Reads a JSON query on stdin.
 *
 * - {"account_id","names"}: prints {"<name>":"<stream id>"} for each requested stream name.
 * - {"account_id","mode":"inventory"}: prints {"count":"<n>","names":"<a,b,...>"} for every K2
 *   stream on the account, so a root can check the account stream limit at plan time (ADR 0017).
 */
import { cfApi, requiredEnv } from "./lib/cloudflare-api.ts";

const query = JSON.parse(await Bun.stdin.text()) as {
  account_id: string;
  names?: string;
  mode?: string;
};
const token = requiredEnv("CLOUDFLARE_API_TOKEN");
const streams = await cfApi<{ id: string; name: string }[]>(
  token,
  `https://api.cloudflare.com/client/v4/accounts/${query.account_id}/k2/streams?per_page=100`,
);

if (query.mode === "inventory") {
  const names = streams.map((s) => s.name.toLowerCase()).sort();
  process.stdout.write(JSON.stringify({ count: String(names.length), names: names.join(",") }));
  process.exit(0);
}

const ids = new Map(streams.map((s) => [s.name.toLowerCase(), s.id]));

const result: Record<string, string> = {};
for (const name of (query.names ?? "").split(",").filter(Boolean)) {
  const id = ids.get(name.toLowerCase());
  if (!id) {
    console.error(`K2 stream ${name} does not exist. Apply terraform_data.k2_streams first.`);
    process.exit(1);
  }
  result[name] = id;
}
process.stdout.write(JSON.stringify(result));
