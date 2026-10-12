import { env } from "cloudflare:workers";
import { auth } from "@clerk/tanstack-react-start/server";
import { createFileRoute } from "@tanstack/react-router";

/**
 * CSV of the admin Costs view: `GET /admin-export/costs?from=&to=&userId=&projectId=&groupBy=`
 * returns `GET /v1/admin/costs?…&format=csv` as a download. The browser sends only its Clerk
 * session cookie; this Worker calls the API with `Authorization: Bearer`, so no token is ever in
 * a URL. The API decides admin rights; anyone else gets a plain 404.
 */

const FILTERS = ["from", "to", "userId", "projectId", "groupBy"] as const;

const plain = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

export const Route = createFileRoute("/admin-export/costs")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const incoming = new URL(request.url).searchParams;
        const query = new URLSearchParams();
        for (const key of FILTERS) {
          const value = incoming.get(key);
          if (value && value.length <= 200) query.set(key, value);
        }
        query.set("format", "csv");

        const { getToken } = await auth();
        const token = await getToken();
        if (!token) return plain(401, "Sign in to continue");

        const upstream = await env.API.fetch(
          new Request(`https://api.internal/v1/admin/costs?${query}`, {
            headers: { authorization: `Bearer ${token}` },
          }),
        );
        if (upstream.status === 401) return plain(401, "Sign in to continue");
        if (!upstream.ok || !upstream.body) return plain(404, "Not found");

        const from = query.get("from") ?? "start";
        const to = query.get("to") ?? "now";
        const name = `rhumbatron-costs-${query.get("groupBy") ?? "user"}-${from}-${to}.csv`;
        return new Response(upstream.body, {
          status: 200,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${name.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      },
    },
  },
});
