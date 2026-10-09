/**
 * Authenticated client for the public dev API, as the Clerk smoke user (same credentials as
 * `bun run smoke:dev`). Clerk session tokens live 60 seconds, so every request mints a fresh one.
 */

export type Reply<T = unknown> = {
  status: number;
  data?: T;
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
};

export type Api = {
  base: string;
  request<T>(method: string, path: string, body?: unknown): Promise<Reply<T>>;
  close(): Promise<void>;
};

export async function connect(base: string, secretKey: string, userId: string): Promise<Api> {
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
  return {
    base,
    async request<T>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
      const { jwt } = await clerk<{ jwt: string }>(`/sessions/${session.id}/tokens`, {});
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      try {
        const parsed = JSON.parse(text) as Omit<Reply<T>, "status">;
        return { status: response.status, ...parsed };
      } catch {
        return { status: response.status, error: { message: text.slice(0, 200) } };
      }
    },
    async close() {
      await clerk(`/sessions/${session.id}/revoke`, {});
    },
  };
}

/** Polls `read` every `everyMs` until `done` holds or the deadline passes. Returns the last value. */
export async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  { timeoutMs, everyMs }: { timeoutMs: number; everyMs: number },
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(everyMs);
    value = await read();
  }
  return value;
}
