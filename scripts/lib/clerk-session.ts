/**
 * Signs in as a Clerk user for scripts that call the API (e2e, smoke). A development instance mints
 * session tokens with the Backend API. A production instance rejects that, and prod rejects tokens
 * without `azp`, so there the script redeems a one-time sign-in token on the Frontend API from the
 * app origin. Tokens and secrets are never printed.
 */
export type Session = { token(): Promise<string>; close(): Promise<void> };

/** Clerk session tokens live 60 seconds. Reuse one for at most this long. */
const TOKEN_REUSE_MS = 30_000;

function backendClient(secretKey: string) {
  return async function clerkBackend(method: string, path: string, body?: unknown) {
    const response = await fetch(`https://api.clerk.com/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, json };
  };
}

type Backend = ReturnType<typeof backendClient>;

function cached(mint: () => Promise<string>): () => Promise<string> {
  let token = "";
  let at = 0;
  return async () => {
    if (!token || Date.now() - at > TOKEN_REUSE_MS) {
      token = await mint();
      at = Date.now();
    }
    return token;
  };
}

/** Development instance: Backend API session and tokens. */
async function backendSession(clerkBackend: Backend, sessionId: string): Promise<Session> {
  return {
    token: cached(async () => {
      const r = await clerkBackend("POST", `/sessions/${sessionId}/tokens`, {});
      if (r.status !== 200) throw new Error(`Clerk session token returned ${r.status}`);
      return r.json.jwt as string;
    }),
    async close() {
      await clerkBackend("POST", `/sessions/${sessionId}/revoke`);
    },
  };
}

/**
 * Production instance: a one-time sign-in token, redeemed on the Frontend API from the app origin,
 * so the session token carries `azp` like a browser session. Fresh tokens come from the same
 * Frontend API client; the Backend API revokes the session at the end.
 */
async function ticketSession(clerkBackend: Backend, userId: string): Promise<Session> {
  const domains = await clerkBackend("GET", "/domains");
  const domain = (
    (domains.json.data ?? []) as { name: string; frontend_api_url: string; is_satellite: boolean }[]
  ).find((d) => !d.is_satellite);
  if (!domain) throw new Error(`Clerk domains returned ${domains.status} with no primary domain`);
  const origin = `https://${domain.name}`;
  const fapi = domain.frontend_api_url;

  const ticket = await clerkBackend("POST", "/sign_in_tokens", {
    user_id: userId,
    expires_in_seconds: 120,
  });
  if (ticket.status !== 200) throw new Error(`Clerk sign-in token returned ${ticket.status}`);
  const signIn = await fetch(`${fapi}/v1/client/sign_ins`, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ strategy: "ticket", ticket: ticket.json.token as string }),
    signal: AbortSignal.timeout(20_000),
  });
  const signed = (await signIn.json()) as {
    response?: { status?: string; created_session_id?: string };
  };
  const sessionId = signed.response?.created_session_id;
  if (signIn.status !== 200 || signed.response?.status !== "complete" || !sessionId) {
    throw new Error(`Clerk ticket sign-in returned ${signIn.status} ${signed.response?.status}`);
  }
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return {
    token: cached(async () => {
      const r = await fetch(`${fapi}/v1/client/sessions/${sessionId}/tokens`, {
        method: "POST",
        headers: { origin, cookie },
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await r.json()) as { jwt?: string };
      if (r.status !== 200 || !body.jwt)
        throw new Error(`Clerk session token returned ${r.status}`);
      return body.jwt;
    }),
    async close() {
      await clerkBackend("POST", `/sessions/${sessionId}/revoke`);
    },
  };
}

export async function signIn(secretKey: string, userId: string): Promise<Session> {
  const clerkBackend = backendClient(secretKey);
  const created = await clerkBackend("POST", "/sessions", { user_id: userId });
  if (created.status === 200) return backendSession(clerkBackend, created.json.id as string);
  const code = (created.json.errors as { code?: string }[] | undefined)?.[0]?.code;
  if (code === "request_invalid_for_environment") return ticketSession(clerkBackend, userId);
  throw new Error(`Clerk session returned ${created.status} ${code ?? ""}`);
}
