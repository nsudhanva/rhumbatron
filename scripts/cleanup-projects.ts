/**
 * Archives the smoke-test Projects of the smoke user on dev (AGENTS.md section 43).
 * Usage: bun run cleanup:projects [--dry-run]
 *
 * Matches only slugs `smoke-<digits>` and `sandbox-<digits>` (scripts/smoke.ts). Every other
 * Project, such as `acme-shop-demo`, is kept. Archiving goes through `DELETE /v1/projects/:id`,
 * the same path the product uses: the integration Worker then deletes each Project's Artifacts
 * repos and R2 source and context objects. `--dry-run` lists the matches and changes nothing.
 */
const api = "https://api-dev.rhumbatron.com";
const SMOKE_SLUG = /^(smoke|sandbox)-\d+$/;
const NEVER = new Set(["acme-shop-demo"]);
const PAGE = 200;

const secretKey = process.env.CLERK_SECRET_KEY;
const userId = process.env.CLERK_SMOKE_USER_ID;
if (!secretKey || !userId) {
  console.error("CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID are required (see package.json).");
  process.exit(2);
}
const dryRun = process.argv.includes("--dry-run");

async function clerk<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`https://api.clerk.com/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Clerk ${path} returned ${response.status}`);
  return (await response.json()) as T;
}

const session = await clerk<{ id: string }>("/sessions", { user_id: userId });
// Clerk session tokens live 60 seconds: mint one per request.
const headers = async () => {
  const { jwt } = await clerk<{ jwt: string }>(`/sessions/${session.id}/tokens`, {});
  return { authorization: `Bearer ${jwt}` };
};

type Summary = { id: string; slug: string; name: string; status: string; createdAt: string };

async function listActive(): Promise<Summary[]> {
  const response = await fetch(`${api}/v1/projects?limit=${PAGE}`, { headers: await headers() });
  if (!response.ok) throw new Error(`list projects returned ${response.status}`);
  return ((await response.json()) as { data: Summary[] }).data;
}

const isSmoke = (p: Summary) =>
  p.status === "active" && SMOKE_SLUG.test(p.slug) && !NEVER.has(p.slug);
const line = (p: Summary) => `  ${p.id}  ${p.slug.padEnd(22)} ${p.name.padEnd(16)} ${p.createdAt}`;

let exitCode = 0;
try {
  let listed = await listActive();
  const kept = listed.filter((p) => !isSmoke(p));
  let matches = listed.filter(isSmoke);

  if (dryRun) {
    console.log(
      `dry run: ${matches.length} of ${listed.length} listed Projects match ${SMOKE_SLUG}`,
    );
    for (const p of matches) console.log(line(p));
    console.log(`kept: ${kept.map((p) => p.slug).join(", ") || "none"}`);
    if (listed.length === PAGE) console.log(`(first ${PAGE} only: more may match on the real run)`);
    console.log("nothing archived");
  } else {
    let archived = 0;
    let failed = 0;
    // Archived Projects leave the list, so each pass reaches older ones. Stop when a pass makes
    // no progress, so a failing archive cannot loop.
    while (matches.length > 0) {
      let progress = 0;
      for (const p of matches) {
        const response = await fetch(`${api}/v1/projects/${p.id}`, {
          method: "DELETE",
          headers: await headers(),
        });
        if (response.status === 200) {
          archived += 1;
          progress += 1;
          console.log(`archived ${p.id}  ${p.slug}`);
        } else {
          failed += 1;
          console.error(`FAILED   ${p.id}  ${p.slug}  HTTP ${response.status}`);
        }
      }
      if (progress === 0) break;
      listed = await listActive();
      matches = listed.filter(isSmoke);
    }
    console.log(
      `archived ${archived}, failed ${failed}; kept: ${kept.map((p) => p.slug).join(", ") || "none"}`,
    );
    console.log("cleanup is queued; `bun run cost:report` shows archived Projects not yet cleaned");
    if (failed > 0) exitCode = 1;
  }
} finally {
  await clerk(`/sessions/${session.id}/revoke`, {});
}
process.exit(exitCode);
