import { HealthResponse, VersionResponse } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { activity } from "./activity.ts";
import { agents } from "./agents.ts";
import { candidates } from "./candidates.ts";
import { conflicts } from "./conflicts.ts";
import { cost } from "./cost.ts";
import { deadLetters } from "./dead-letters.ts";
import { decisions } from "./decisions.ts";
import { fixtures } from "./fixtures.ts";
import { errorBody, fail, respond } from "./http.ts";
import { live } from "./live.ts";
import { notifications } from "./notifications.ts";
import { productGraph } from "./product-graph.ts";
import { projects } from "./projects.ts";
import { screenshots } from "./screenshots.ts";
import { verification } from "./verification.ts";
import { workspace } from "./workspace.ts";

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
app.route("/", fixtures);
app.route("/", screenshots);
app.route("/", verification);
app.route("/", activity);
app.route("/", agents);
app.route("/", cost);
app.route("/", workspace);
app.route("/", productGraph);
app.route("/", deadLetters);
app.route("/", decisions);
app.route("/", notifications);
app.route("/", projects);

app.notFound((c) => fail(c, 404, "not_found", "Route not found"));

app.onError((err, c) => {
  console.error(err);
  return c.json(errorBody("internal", "Internal error"), 500);
});

export default app satisfies ExportedHandler<Env>;
