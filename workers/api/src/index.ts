import { HealthResponse, VersionResponse } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { candidates } from "./candidates.ts";
import { conflicts } from "./conflicts.ts";
import { errorBody, fail, respond } from "./http.ts";
import { live } from "./live.ts";
import { projects } from "./projects.ts";

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

// Before `projects`: these handlers answer first, so their own requireAuth runs only once.
app.route("/", live);
app.route("/", conflicts);
app.route("/", candidates);
app.route("/", projects);

app.notFound((c) => fail(c, 404, "not_found", "Route not found"));

app.onError((err, c) => {
  console.error(err);
  return c.json(errorBody("internal", "Internal error"), 500);
});

export default app satisfies ExportedHandler<Env>;
