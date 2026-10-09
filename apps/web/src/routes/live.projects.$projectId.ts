import { env } from "cloudflare:workers";
import { auth } from "@clerk/tanstack-react-start/server";
import { createFileRoute } from "@tanstack/react-router";

/**
 * Same-origin live socket: `GET /live/projects/:projectId` with `Upgrade: websocket`.
 * The browser sends only its Clerk session cookie. This Worker turns it into a session token and
 * calls the API with `Authorization: Bearer`, so no token is ever in a URL (AGENTS.md 12.1, 39).
 * The API checks access and hands the upgrade to ProjectViewDO; the socket is passed through.
 */

const PROJECT_ID = /^proj_[a-z0-9-]+$/;

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export const Route = createFileRoute("/live/projects/$projectId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return plain(426, "Expected a WebSocket upgrade");
        }
        if (!PROJECT_ID.test(params.projectId)) return plain(404, "Project not found");

        const { getToken } = await auth();
        const token = await getToken();
        if (!token) return plain(401, "Sign in to continue");

        const target = new URL(`https://api.internal/v1/projects/${params.projectId}/live`);
        const after = new URL(request.url).searchParams.get("afterSequence");
        if (after && /^\d+$/.test(after)) target.searchParams.set("afterSequence", after);

        const upstream = await env.API.fetch(
          new Request(target, {
            headers: { upgrade: "websocket", authorization: `Bearer ${token}` },
          }),
        );
        if (upstream.status !== 101 || !upstream.webSocket) {
          // Pass the API status through (401, 404, 409) without its body.
          return plain(upstream.status === 101 ? 502 : upstream.status, "Live view unavailable");
        }
        // A fresh Response with mutable headers: later middleware may append headers to it.
        return new Response(null, { status: 101, webSocket: upstream.webSocket });
      },
    },
  },
});
