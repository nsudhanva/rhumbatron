/**
 * JSON RPC over HTTP for the self-hosted stack (services/apps/CONTRACT.md): the core service calls
 * `POST /rpc/<Entrypoint>/<method>` on the internal listener (port 8789) with a JSON array of
 * arguments and gets the JSON result back. Only the methods below are callable.
 */

const RPC_METHODS = {
  AppBuilder: ["build", "probe", "wipeData", "check"],
  AppChecker: ["check"],
  AppData: ["get", "put", "delete", "list"],
} as const satisfies Record<string, readonly string[]>;

type Entrypoint = keyof typeof RPC_METHODS;
/** Loopback stubs of this Worker's entrypoints (`ctx.exports`). */
type Exports = Record<Entrypoint, (options: { props?: unknown }) => unknown>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body ?? null), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Constant-time comparison: the token check must not leak a prefix through timing. */
function sameToken(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function handleRpc(
  request: Request,
  token: string | null | undefined,
  exports: Exports,
): Promise<Response> {
  if (!token) return json(503, { error: "INTERNAL_TOKEN is not set" });
  const auth = request.headers.get("authorization") ?? "";
  if (!sameToken(auth, `Bearer ${token}`)) return json(401, { error: "unauthorized" });

  const match = /^\/rpc\/([A-Za-z]+)\/([A-Za-z]+)$/.exec(new URL(request.url).pathname);
  if (!match) return json(404, { error: "not found" });
  if (request.method !== "POST") return json(405, { error: "use POST" });
  const [, entrypoint = "", method = ""] = match;
  const allowed: readonly string[] | undefined = RPC_METHODS[entrypoint as Entrypoint];
  if (!allowed?.includes(method)) return json(404, { error: `no method ${entrypoint}.${method}` });

  let args: unknown;
  try {
    args = await request.json();
  } catch {
    return json(400, { error: "body must be a JSON array" });
  }
  if (!Array.isArray(args)) return json(400, { error: "body must be a JSON array" });

  // AppData is bound to one store; the caller names it in `x-rpc-props` ({"storeName": "..."}).
  let props: unknown;
  const rawProps = request.headers.get("x-rpc-props");
  if (rawProps) {
    try {
      props = JSON.parse(rawProps);
    } catch {
      return json(400, { error: "x-rpc-props must be JSON" });
    }
  }
  if (entrypoint === "AppData" && typeof (props as { storeName?: unknown })?.storeName !== "string")
    return json(400, { error: "AppData needs x-rpc-props with storeName" });

  try {
    const stub = exports[entrypoint as Entrypoint](props === undefined ? {} : { props }) as Record<
      string,
      (...a: unknown[]) => Promise<unknown>
    >;
    // A method call on the stub itself: RPC stubs do not support `.apply`.
    return json(200, await stub[method]?.(...args));
  } catch (error) {
    return json(500, { error: String(error).slice(0, 2000) });
  }
}
