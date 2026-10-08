import { HealthResponse, VersionResponse } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { errorBody, fail, respond } from "./http.ts";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) =>
  respond(c, HealthResponse, {
    ok: true,
    service: c.env.SERVICE_NAME,
    environment: c.env.ENVIRONMENT,
  }),
);

app.get("/v1/version", (c) =>
  respond(c, VersionResponse, {
    data: { service: c.env.SERVICE_NAME, environment: c.env.ENVIRONMENT },
  }),
);

app.notFound((c) => fail(c, 404, "not_found", "Route not found"));

app.onError((err, c) => {
  console.error(err);
  return c.json(errorBody("internal", "Internal error"), 500);
});

export default app satisfies ExportedHandler<Env>;
