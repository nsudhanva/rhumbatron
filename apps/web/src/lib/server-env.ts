/**
 * Server-only runtime configuration, read from `process.env` at request time.
 * Import it only from server functions and server route handlers.
 */

/** The placeholder origin that API request code builds URLs on. */
const API_PLACEHOLDER = "https://api.internal";

/** Origin of the core API on the internal network. */
const apiInternalUrl = () =>
  (process.env.API_INTERNAL_URL ?? "http://core:8787").replace(/\/+$/, "");

/** Service name and environment, shown in the status bar. */
export const buildInfo = () => ({
  service: process.env.SERVICE_NAME ?? "rhumbatron-web",
  environment: process.env.ENVIRONMENT ?? "local",
});

/** Turns an `https://api.internal/...` URL into the same path on the internal API origin. */
function apiUrl(url: string | URL): URL {
  const source = new URL(url);
  if (source.origin !== API_PLACEHOLDER) throw new Error(`Not an API URL: ${source.origin}`);
  return new URL(`${apiInternalUrl()}${source.pathname}${source.search}`);
}

/**
 * Sends a request built on `https://api.internal` to the core API. Method, headers (the Bearer
 * token among them) and body are kept. An unreachable API answers 502 in the API's error shape,
 * so callers handle it like any other API failure.
 */
export async function apiFetch(request: Request): Promise<Response> {
  try {
    return await fetch(new Request(apiUrl(request.url), request));
  } catch {
    return Response.json(
      { error: { code: "api_unreachable", message: "The API is unreachable" } },
      { status: 502 },
    );
  }
}
