/**
 * Cookie isolation for apps on rhumbatron.com subdomains (ADR 0020, P16-05). The router is the
 * only path in and out of an app, so it can keep apps away from Rhumbatron cookies without a
 * separate zone:
 *
 * - Every cookie that an app sets is stored under a router prefix on the app's own host. A
 *   `Set-Cookie` with a `Domain` attribute is dropped, so an app cannot set a cookie for
 *   rhumbatron.com or for another app.
 * - On the way in, the app sees only the prefixed cookies, with the prefix removed. Cookies that
 *   other hosts set for the whole zone (for example Clerk's `__client_uat`) never reach the app.
 *
 * Pure functions: unit tested in cookies.critical.test.ts.
 */

const APP_COOKIE_PREFIX = "rba_";

/** RFC 6265 cookie-name token characters. */
const NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** The `Cookie` header that the app may see, or null when none of its own cookies remain. */
export function appRequestCookies(header: string | null): string | null {
  if (!header) return null;
  const kept: string[] = [];
  for (const part of header.split(";")) {
    const pair = part.trim();
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (!name.startsWith(APP_COOKIE_PREFIX) || name.length === APP_COOKIE_PREFIX.length) continue;
    kept.push(`${name.slice(APP_COOKIE_PREFIX.length)}=${pair.slice(eq + 1).trim()}`);
  }
  return kept.length > 0 ? kept.join("; ") : null;
}

/**
 * Rewrites one `Set-Cookie` value from an app: the name gets the router prefix. Returns null to
 * drop the cookie: a `Domain` attribute (any value), or a malformed name.
 */
export function appSetCookie(value: string): string | null {
  const [first = "", ...attributes] = value.split(";");
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  if (!NAME.test(name)) return null;
  for (const attribute of attributes) {
    const key = attribute.split("=")[0]?.trim().toLowerCase();
    if (key === "domain") return null;
  }
  const rest = attributes.length > 0 ? `;${attributes.join(";")}` : "";
  return `${APP_COOKIE_PREFIX}${name}=${first.slice(eq + 1).trim()}${rest}`;
}

/** Request headers for the app: only its own cookies, never Cloudflare Access assertions. */
export function appRequestHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  const cookies = appRequestCookies(headers.get("cookie"));
  if (cookies) out.set("cookie", cookies);
  else out.delete("cookie");
  for (const name of ["cf-access-jwt-assertion", "cf-access-authenticated-user-email"]) {
    out.delete(name);
  }
  return out;
}

/** Response headers to the browser: app cookies rewritten, cookies with a Domain dropped. */
export function appResponseHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  const cookies = headers.getSetCookie();
  out.delete("set-cookie");
  for (const cookie of cookies) {
    const rewritten = appSetCookie(cookie);
    if (rewritten) out.append("set-cookie", rewritten);
  }
  return out;
}
