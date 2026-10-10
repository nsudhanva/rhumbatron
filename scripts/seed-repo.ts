/**
 * Creates the empty repository of a Project that has none yet: Projects created before every
 * Project got one (one commit with a `.gitignore`, Canonical Generation 0). Idempotent: the
 * integration Worker seeds only a Project whose canonical source is unassigned, so a Project with
 * source is never changed. On prod it then asks for the app ("Deploy app"), which shows
 * "Nothing built yet" until the first Change ships.
 *
 * Usage: bun scripts/seed-repo.ts <projectId> <dev|prod> [--user <Clerk user ID or email>]
 *
 * Signs in to that environment's Clerk instance (Keychain `rhumbatron-clerk-secret-key-<env>`, or
 * CLERK_SECRET_KEY) as the Project's member: `--user`, else the smoke user
 * (`rhumbatron-clerk-smoke-user-id-<env>`, or CLERK_SMOKE_USER_ID). The session is revoked at the
 * end; secrets and tokens are never printed. Cost: a few API requests, 1 or 2 Queue messages, one
 * Artifacts repository. No model call, no Sandbox.
 */

import { $ } from "bun";

const apis: Record<string, string> = {
  dev: "https://api-dev.rhumbatron.com",
  prod: "https://api.rhumbatron.com",
};

const [projectId = "", environment = ""] = process.argv.slice(2);
const userFlag = process.argv.indexOf("--user");
const userArg = userFlag > 0 ? process.argv[userFlag + 1] : undefined;
const base = apis[environment];
if (!/^proj_[a-z0-9-]+$/.test(projectId) || !base) {
  console.error(
    "Usage: bun scripts/seed-repo.ts <projectId> <dev|prod> [--user <Clerk user ID or email>]",
  );
  process.exit(2);
}

const keychain = async (service: string) =>
  (await $`security find-generic-password -s ${service} -w`.quiet().nothrow().text()).trim();
const secretKey =
  process.env.CLERK_SECRET_KEY || (await keychain(`rhumbatron-clerk-secret-key-${environment}`));
if (!secretKey) {
  console.error(
    `No Clerk secret key: add the Keychain item rhumbatron-clerk-secret-key-${environment}.`,
  );
  process.exit(2);
}

async function clerk(method: string, path: string, body?: unknown) {
  const response = await fetch(`https://api.clerk.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  return {
    status: response.status,
    json: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

/** The Clerk user ID: `--user` as an ID or an email address, else the smoke user. */
async function resolveUser(): Promise<string> {
  if (userArg?.startsWith("user_")) return userArg;
  if (userArg?.includes("@")) {
    const found = await clerk("GET", `/users?email_address=${encodeURIComponent(userArg)}`);
    const users = found.json as unknown as { id: string }[];
    if (found.status !== 200 || !Array.isArray(users) || !users[0]) {
      throw new Error(`No Clerk user with that email address (status ${found.status})`);
    }
    return users[0].id;
  }
  const smoke =
    process.env.CLERK_SMOKE_USER_ID ||
    (await keychain(`rhumbatron-clerk-smoke-user-id-${environment}`));
  if (!smoke) throw new Error("No --user and no smoke user ID");
  return smoke;
}

type Session = { token(): Promise<string>; close(): Promise<void> };

/**
 * A development instance mints session tokens with the Backend API. A production instance does
 * not, and prod rejects tokens without `azp`, so there a one-time sign-in token is redeemed on the
 * Frontend API from the app origin (as scripts/e2e.ts does).
 */
async function signIn(userId: string): Promise<Session> {
  const created = await clerk("POST", "/sessions", { user_id: userId });
  if (created.status === 200) {
    const sessionId = created.json.id as string;
    return {
      async token() {
        const r = await clerk("POST", `/sessions/${sessionId}/tokens`, {});
        if (r.status !== 200) throw new Error(`Clerk session token returned ${r.status}`);
        return r.json.jwt as string;
      },
      async close() {
        await clerk("POST", `/sessions/${sessionId}/revoke`);
      },
    };
  }
  const code = (created.json.errors as { code?: string }[] | undefined)?.[0]?.code;
  if (code !== "request_invalid_for_environment") {
    throw new Error(`Clerk session returned ${created.status} ${code ?? ""}`);
  }
  const domains = await clerk("GET", "/domains");
  const domain = (
    (domains.json.data ?? []) as { name: string; frontend_api_url: string; is_satellite: boolean }[]
  ).find((d) => !d.is_satellite);
  if (!domain) throw new Error(`Clerk domains returned ${domains.status} with no primary domain`);
  const origin = `https://${domain.name}`;
  const fapi = domain.frontend_api_url;
  const ticket = await clerk("POST", "/sign_in_tokens", {
    user_id: userId,
    expires_in_seconds: 120,
  });
  if (ticket.status !== 200) throw new Error(`Clerk sign-in token returned ${ticket.status}`);
  const signedIn = await fetch(`${fapi}/v1/client/sign_ins`, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ strategy: "ticket", ticket: ticket.json.token as string }),
    signal: AbortSignal.timeout(20_000),
  });
  const signed = (await signedIn.json()) as {
    response?: { status?: string; created_session_id?: string };
  };
  const sessionId = signed.response?.created_session_id;
  if (signedIn.status !== 200 || signed.response?.status !== "complete" || !sessionId) {
    throw new Error(`Clerk ticket sign-in returned ${signedIn.status} ${signed.response?.status}`);
  }
  const cookie = signedIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return {
    async token() {
      const r = await fetch(`${fapi}/v1/client/sessions/${sessionId}/tokens`, {
        method: "POST",
        headers: { origin, cookie },
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await r.json()) as { jwt?: string };
      if (r.status !== 200 || !body.jwt)
        throw new Error(`Clerk session token returned ${r.status}`);
      return body.jwt;
    },
    async close() {
      await clerk("POST", `/sessions/${sessionId}/revoke`);
    },
  };
}

const session = await signIn(await resolveUser());

async function call(method: string, path: string): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${await session.token()}` },
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

type ProjectView = { data?: { canonical: { artifactRef: string; generation: number } } };
type AppView = { data?: { enabled: boolean; app: { status: string; url: string } | null } };

let exitCode = 0;
try {
  const before = await call("GET", `/v1/projects/${projectId}`);
  if (before.status !== 200) {
    throw new Error(`GET project returned ${before.status}: is --user a member of the Project?`);
  }
  let canonical = (before.json as ProjectView).data?.canonical;
  if (canonical?.artifactRef !== "unassigned") {
    console.log(`source already assigned: ${canonical?.artifactRef} (S${canonical?.generation})`);
  } else {
    const queued = await call("POST", `/v1/projects/${projectId}/provision`);
    if (queued.status !== 202) throw new Error(`POST provision returned ${queued.status}`);
    console.log("provisioning queued; waiting for the empty repository");
    const until = Date.now() + 120_000;
    while (canonical?.artifactRef === "unassigned" && Date.now() < until) {
      await Bun.sleep(4_000);
      canonical = ((await call("GET", `/v1/projects/${projectId}`)).json as ProjectView).data
        ?.canonical;
    }
    if (canonical?.artifactRef === "unassigned") {
      throw new Error("the repository was not created within 2 minutes; run again shortly");
    }
    console.log(`source assigned: ${canonical?.artifactRef} (S${canonical?.generation})`);
  }

  const app = (await call("GET", `/v1/projects/${projectId}/app`)).json as AppView;
  if (!app.data?.enabled) {
    console.log("live apps are off on this environment; done");
  } else if (app.data.app && app.data.app.status !== "failed") {
    console.log(`app: ${app.data.app.status} at ${app.data.app.url}`);
  } else {
    const deploy = await call("POST", `/v1/projects/${projectId}/app`);
    console.log(`deploy app: ${deploy.status} ${JSON.stringify(deploy.json)}`);
    const until = Date.now() + 90_000;
    let view = app;
    while (Date.now() < until && (!view.data?.app || view.data.app.status === "building")) {
      await Bun.sleep(4_000);
      view = (await call("GET", `/v1/projects/${projectId}/app`)).json as AppView;
    }
    const row = view.data?.app;
    console.log(row ? `app: ${row.status} at ${row.url}` : "app: not provisioned yet");
  }
} catch (error) {
  console.error(String(error));
  exitCode = 1;
} finally {
  await session.close();
}
process.exit(exitCode);
