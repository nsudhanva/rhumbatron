/**
 * Vectorize adapter (ADR 0003). Provider 5.27 has no Vectorize index resource.
 * Invoked only by terraform_data.vectorize_index (sync) and terraform_data.vectorize_index_teardown
 * (destroy). Read-before-write; safe to run again.
 *
 * sync: creates the index when it is missing. An existing index with other dimensions or another
 *   metric is an error: the adapter never deletes or replaces an index on its own.
 * destroy: deletes the index. Safe: it holds only derived data (file summaries) that
 *   rhumbatron-indexer rebuilds from canonical source.
 */
import { assertInvokedByTerraform, cfApi, requiredEnv } from "./lib/cloudflare-api.ts";

assertInvokedByTerraform("vectorize-sync");

type Config = { name: string; dimensions: number; metric: "cosine" | "euclidean" | "dot-product" };
type Index = { name: string; config?: { dimensions?: number; metric?: string } };

const token = requiredEnv("CLOUDFLARE_API_TOKEN");
const accountId = requiredEnv("VECTORIZE_ACCOUNT_ID");
const mode = requiredEnv("VECTORIZE_MODE");
const config = JSON.parse(requiredEnv("VECTORIZE_CONFIG")) as Config;
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes`;

const existing = (await cfApi<Index[]>(token, base)).find((i) => i.name === config.name);

if (mode === "destroy") {
  if (existing) {
    await cfApi(token, `${base}/${config.name}`, { method: "DELETE" });
    console.log(`deleted Vectorize index ${config.name}`);
  }
  process.exit(0);
}

if (!existing) {
  await cfApi(token, base, {
    method: "POST",
    body: JSON.stringify({
      name: config.name,
      description: "Rhumbatron semantic memory: file summaries per Project (ADR 0003)",
      config: { dimensions: config.dimensions, metric: config.metric },
    }),
  });
  console.log(
    `created Vectorize index ${config.name} (${config.dimensions} dims, ${config.metric})`,
  );
} else if (
  existing.config?.dimensions !== config.dimensions ||
  existing.config?.metric !== config.metric
) {
  console.error(
    `Vectorize index ${config.name} exists with ${existing.config?.dimensions} dims, ${existing.config?.metric}; wanted ${config.dimensions}, ${config.metric}. Dimensions and metric cannot change in place. Destroy and recreate it through Terraform on purpose.`,
  );
  process.exit(1);
} else {
  console.log(`Vectorize index ${config.name} is in sync.`);
}
