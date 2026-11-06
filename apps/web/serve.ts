/**
 * Production server: `bun serve.ts` after `bun run build`.
 * Serves the client build (`dist/client`) as static files and sends every other request to the
 * TanStack Start server entry (`dist/server/server.js`, built from src/server.ts).
 * Listens on `HOST` (default 0.0.0.0) and `PORT` (default 3000).
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

type ServerEntry = { fetch(request: Request): Response | Promise<Response> };

const root = import.meta.dir;
const clientDir = join(root, "dist/client");
const entry = ((await import(join(root, "dist/server/server.js"))) as { default: ServerEntry })
  .default;

/** Every file of the client build, by URL path. Fixed at startup: requests never touch the disk path. */
const files = new Map<string, string>();
for (const name of readdirSync(clientDir, { recursive: true, encoding: "utf8" })) {
  const path = join(clientDir, name);
  if (!statSync(path).isFile()) continue;
  files.set(`/${relative(clientDir, path).split(sep).join("/")}`, path);
}

/** Fingerprinted build output never changes under the same name; the mark can change. */
function cacheControl(pathname: string): string | undefined {
  if (pathname.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (pathname === "/favicon.svg") return "public, max-age=86400";
  return undefined;
}

/**
 * The public URL of a request. Caddy terminates TLS and sends `X-Forwarded-Proto`, so
 * same-origin checks (CSRF middleware, Clerk) compare against `https://` and not the internal hop.
 */
function publicRequest(request: Request): Request {
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (proto !== "https" && proto !== "http") return request;
  const url = new URL(request.url);
  if (url.protocol === `${proto}:`) return request;
  url.protocol = `${proto}:`;
  return new Request(url, request);
}

const server = Bun.serve({
  hostname: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3000),
  // Server-rendered pages stream; give slow API reads time before the socket closes.
  idleTimeout: 60,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const file = (request.method === "GET" || request.method === "HEAD") && files.get(pathname);
    if (file) {
      const cache = cacheControl(pathname);
      return new Response(Bun.file(file), cache ? { headers: { "cache-control": cache } } : {});
    }
    return entry.fetch(publicRequest(request));
  },
});

// biome-ignore lint/suspicious/noConsole: one startup line for the container log.
console.log(`rhumbatron-web listening on ${server.url}`);
