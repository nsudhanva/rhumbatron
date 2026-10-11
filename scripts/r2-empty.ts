/**
 * Empties one R2 bucket so Terraform can delete it (AGENTS.md section 11.4 step 9). R2 refuses to
 * delete a bucket that still holds objects. Invoked only by a `when = destroy` provisioner on a
 * real environment destroy. Refuses any bucket whose name does not end in `-dev`, so it can never
 * empty a prod bucket. Safe to repeat: an empty bucket is done at once.
 */
import { assertInvokedByTerraform, cfApi, requiredEnv } from "./lib/cloudflare-api.ts";

assertInvokedByTerraform("r2-empty");

const token = requiredEnv("CLOUDFLARE_API_TOKEN");
const accountId = requiredEnv("R2_ACCOUNT_ID");
const bucket = requiredEnv("R2_BUCKET");
if (!bucket.endsWith("-dev")) {
  console.error(
    `r2-empty refuses ${bucket}: only a -dev bucket can be emptied. Nothing was deleted.`,
  );
  process.exit(1);
}
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`;
const objectUrl = (key: string) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
const PARALLEL = 8;

let deleted = 0;
// Each pass lists the first page again: the objects deleted before it are gone from the listing.
for (;;) {
  const page = await cfApi<{ key: string }[]>(token, `${base}?per_page=1000`);
  if (page.length === 0) break;
  for (let i = 0; i < page.length; i += PARALLEL) {
    await Promise.all(
      page.slice(i, i + PARALLEL).map((o) => cfApi(token, objectUrl(o.key), { method: "DELETE" })),
    );
  }
  deleted += page.length;
  console.log(`deleted ${deleted} objects from ${bucket}`);
}
console.log(`${bucket} is empty (${deleted} objects deleted).`);
