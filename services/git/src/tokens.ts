/**
 * Repo access tokens. A token is self-describing and signed:
 *
 *   rgt1.<base64url(payload)>.<base64url(hmac-sha256(secret, "rgt1." + payload))>
 *
 * The payload names the token ID, the repo, the scope, and the expiry in Unix seconds. The plaintext
 * that `createToken` returns appends `?expires=<unix>`, like Cloudflare Artifacts. Callers strip
 * that suffix; `parseToken` also accepts it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "rgt1";

export type Scope = "read" | "write";

export type TokenClaims = {
  /** Token ID. */
  id: string;
  /** Repo name. */
  repo: string;
  scope: Scope;
  /** Expiry in Unix seconds. */
  exp: number;
};

const b64 = (data: string | Buffer) => Buffer.from(data).toString("base64url");

function sign(secret: string, body: string) {
  return createHmac("sha256", secret).update(`${PREFIX}.${body}`).digest();
}

/** Signs the claims. Returns the bare token and the Artifacts-style plaintext. */
export function mintToken(secret: string, claims: TokenClaims) {
  const body = b64(
    JSON.stringify({ i: claims.id, r: claims.repo, s: claims.scope, e: claims.exp }),
  );
  const token = `${PREFIX}.${body}.${b64(sign(secret, body))}`;
  return { token, plaintext: `${token}?expires=${claims.exp}` };
}

/**
 * Verifies the signature and decodes the claims. Returns null for any malformed or forged token.
 * Expiry, repo, scope, and revocation are the caller's checks.
 */
export function parseToken(secret: string, raw: string): TokenClaims | null {
  const token = raw.split("?expires=")[0] ?? "";
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, body = "", mac = ""] = parts;
  const expected = sign(secret, body);
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      typeof p.i !== "string" ||
      typeof p.r !== "string" ||
      (p.s !== "read" && p.s !== "write") ||
      typeof p.e !== "number"
    ) {
      return null;
    }
    return { id: p.i, repo: p.r, scope: p.s, exp: p.e };
  } catch {
    return null;
  }
}

/** Constant-time string compare for the admin bearer token. */
export function sameSecret(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
