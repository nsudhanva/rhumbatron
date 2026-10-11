/**
 * Archives the smoke-test Projects of the smoke user on prod (AGENTS.md section 43).
 * CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID must both be set in the environment, for the prod
 * Clerk instance. Nothing reads them from the Keychain.
 * Usage: bun run cleanup:projects [--dry-run] [--all]
 *
 * Matches only slugs `smoke-<digits>` and `sandbox-<digits>` (scripts/smoke.ts). Every other
 * Project, such as `acme-shop-demo`, is kept. `--all` matches every active Project the smoke user
 * owns, fixtures included. Archiving goes through `DELETE /v1/projects/:id`,
 * the same path the product uses: the integration Worker then deletes each Project's Artifacts
 * repos and R2 source and context objects. `--dry-run` lists the matches and changes nothing.
 */
const api = "https://api.rhumbatron.com";
const SMOKE_SLUG = /^(smoke|sandbox)-\d+$/;
const NEVER = new Set(["acme-shop-demo"]);
const PAGE = 200;

const secretKey = process.env.CLERK_SECRET_KEY;
const userId = process.env.CLERK_SMOKE_USER_ID;
if (!secretKey || !userId) {
  console.error("CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID are required (prod Clerk instance).");
  process.exit(2);
}
const dryRun = process.argv.includes("--dry-run");
const all = process.argv.includes("--all");

async function clerk<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(`https://api.clerk.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Clerk ${path} returned ${response.status}`);
  return (await response.json()) as T;
}

/**
 * The prod Clerk instance refuses Backend API sessions, so the script signs in with a one-time
 * sign-in token on the Frontend API from the app origin (the same flow as scripts/e2e.ts). Clerk
 * session tokens live 60 seconds: `headers()` mints one per request.
 */
async function signIn() {
  const domains = await clerk<{
    data: { name: string; frontend_api_url: string; is_satellite: boolean }[];
  }>("/domains", undefined, "GET");
  const domain = domains.data.find((d) => !d.is_satellite);
  if (!domain) throw new Error("Clerk has no primary domain");
  const origin = `https://${domain.name}`;
  const fapi = domain.frontend_api_url;
  const ticket = await clerk<{ token: string }>("/sign_in_tokens", {
    user_id: userId,
    expires_in_seconds: 120,
  });
  const response = await fetch(`${fapi}/v1/client/sign_ins`, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ strategy: "ticket", ticket: ticket.token }),
  });
  const signed = (await response.json()) as {
    response?: { status?: string; created_session_id?: string };
  };
  const sessionId = signed.response?.created_session_id;
  if (response.status !== 200 || signed.response?.status !== "complete" || !sessionId) {
    throw new Error(`Clerk ticket sign-in returned ${response.status}`);
  }
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return {
    headers: async () => {
      const r = await fetch(`${fapi}/v1/client/sessions/${sessionId}/tokens`, {
        method: "POST",
        headers: { origin, cookie },
      });
      const body = (await r.json()) as { jwt?: string };
      if (r.status !== 200 || !body.jwt)
        throw new Error(`Clerk session token returned ${r.status}`);
      return { authorization: `Bearer ${body.jwt}` };
    },
    close: () => clerk(`/sessions/${sessionId}/revoke`, {}),
  };
}

const session = await signIn();
const headers = session.headers;

type Summary = { id: string; slug: string; name: string; status: string; createdAt: string };

async function listActive(): Promise<Summary[]> {
  const response = await fetch(`${api}/v1/projects?limit=${PAGE}`, { headers: await headers() });
  if (!response.ok) throw new Error(`list projects returned ${response.status}`);
  return ((await response.json()) as { data: Summary[] }).data;
}

const isSmoke = (p: Summary) =>
  p.status === "active" && (all || (SMOKE_SLUG.test(p.slug) && !NEVER.has(p.slug)));
const line = (p: Summary) => `  ${p.id}  ${p.slug.padEnd(22)} ${p.name.padEnd(16)} ${p.createdAt}`;

let exitCode = 0;
try {
  let listed = await listActive();
  const kept = listed.filter((p) => !isSmoke(p));
  let matches = listed.filter(isSmoke);

  if (dryRun) {
    console.log(
      `dry run: ${matches.length} of ${listed.length} listed Projects match ${all ? "--all" : SMOKE_SLUG}`,
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
  await session.close();
}
process.exit(exitCode);
