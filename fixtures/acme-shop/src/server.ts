import { createApp } from "./app";
import { createStore } from "./store";

const app = createApp(createStore());
const port = Number(process.env.PORT ?? 8787);

Bun.serve({
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/api/")) return app.fetch(req);
    const file = Bun.file(pathname === "/" ? "public/index.html" : `public${pathname}`);
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});

process.stdout.write(`acme-shop listening on :${port}\n`);
