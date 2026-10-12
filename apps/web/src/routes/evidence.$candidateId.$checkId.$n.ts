import { env } from "cloudflare:workers";
import { auth } from "@clerk/tanstack-react-start/server";
import { createFileRoute } from "@tanstack/react-router";

/**
 * Same-origin Browser Run screenshot: `GET /evidence/:candidateId/:checkId/:n` returns the PNG.
 * The browser sends only its Clerk session cookie. This Worker turns it into a session token and
 * calls the API (`/v1/candidates/:candidateId/evidence/:checkId/screenshots/:n`) with
 * `Authorization: Bearer`, so no token is ever in a URL. The API checks
 * project access and derives the R2 key from the Evidence row, never from the request.
 */

// Same rules as workers/api/src/screenshots.ts.
const CANDIDATE_ID = /^cand_[a-z0-9]+$/;
const CHECK_ID = /^[a-z0-9-]{1,64}$/;
const SCREENSHOT_N = /^[1-8]$/;

const plain = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

export const Route = createFileRoute("/evidence/$candidateId/$checkId/$n")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { candidateId, checkId, n } = params;
        if (!CANDIDATE_ID.test(candidateId) || !CHECK_ID.test(checkId) || !SCREENSHOT_N.test(n)) {
          return plain(404, "Screenshot not found");
        }

        const { getToken } = await auth();
        const token = await getToken();
        if (!token) return plain(401, "Sign in to continue");

        const upstream = await env.API.fetch(
          new Request(
            `https://api.internal/v1/candidates/${candidateId}/evidence/${checkId}/screenshots/${n}`,
            { headers: { authorization: `Bearer ${token}` } },
          ),
        );
        const type = upstream.headers.get("content-type") ?? "";
        if (upstream.status === 401) return plain(401, "Sign in to continue");
        if (!upstream.ok || !upstream.body || !type.startsWith("image/")) {
          return plain(404, "Screenshot not found");
        }
        const hash = upstream.headers.get("x-content-hash");
        return new Response(upstream.body, {
          status: 200,
          headers: {
            "content-type": type,
            "cache-control": "private, max-age=300",
            "x-content-type-options": "nosniff",
            ...(hash ? { "x-content-hash": hash } : {}),
          },
        });
      },
    },
  },
});
