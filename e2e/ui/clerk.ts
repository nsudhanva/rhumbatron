/// <reference lib="dom" />
/**
 * Signs the Clerk prod smoke user into a browser page with a one-time sign-in token.
 * CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID come from the environment only.
 */
import type { Page } from "@playwright/test";

const API = "https://api.rhumbatron.com";

function env() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const userId = process.env.CLERK_SMOKE_USER_ID;
  if (!secretKey || !userId) {
    throw new Error("CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID are required (prod Clerk instance).");
  }
  return { secretKey, userId };
}

async function clerkBackend<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const { secretKey } = env();
  const response = await fetch(`https://api.clerk.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Clerk ${path} returned ${response.status}`);
  return (await response.json()) as T;
}

async function signInToken(): Promise<string> {
  const { userId } = env();
  const ticket = await clerkBackend<{ token: string }>("/sign_in_tokens", {
    user_id: userId,
    expires_in_seconds: 300,
  });
  return ticket.token;
}

/** Opens the Clerk sign-in page with a ticket and waits until the app shows the signed-in home. */
export async function signInPage(page: Page, baseURL: string): Promise<void> {
  const token = await signInToken();
  await page.goto(`${baseURL}/sign-in?__clerk_ticket=${encodeURIComponent(token)}`);
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 60_000 });
  await page.waitForFunction(
    () => document.cookie.includes("__session") || document.cookie.includes("__client_uat"),
    undefined,
    { timeout: 30_000 },
  );
}

/** API helper with a Bearer session token taken from the page's Clerk instance. */
export async function apiFetch(page: Page, path: string, init: RequestInit = {}) {
  await page.waitForFunction(
    () => !!(window as unknown as { Clerk?: { session?: unknown } }).Clerk?.session,
    undefined,
    { timeout: 30_000 },
  );
  const token = await page.evaluate(async () => {
    const clerk = (window as unknown as { Clerk?: { session?: { getToken(): Promise<string> } } })
      .Clerk;
    return (await clerk?.session?.getToken()) ?? null;
  });
  if (!token) throw new Error("no Clerk session token in the page");
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return response;
}
