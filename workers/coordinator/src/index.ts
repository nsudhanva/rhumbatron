export { ProjectRootDO } from "./project-root-do.ts";
export { ProjectViewDO } from "./project-view-do.ts";
export { ResourceShardDO } from "./resource-shard-do.ts";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: env.SERVICE_NAME, environment: env.ENVIRONMENT });
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
