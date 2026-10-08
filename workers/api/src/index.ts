import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) =>
  c.json({ ok: true, service: c.env.SERVICE_NAME, environment: c.env.ENVIRONMENT }),
);

app.get("/v1/version", (c) =>
  c.json({ service: c.env.SERVICE_NAME, environment: c.env.ENVIRONMENT }),
);

app.notFound((c) => c.json({ error: { code: "not_found", message: "Route not found" } }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: { code: "internal", message: "Internal error" } }, 500);
});

export default app satisfies ExportedHandler<Env>;
