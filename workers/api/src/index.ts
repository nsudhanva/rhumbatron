import { HealthResponse, VersionResponse } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { activity } from "./activity.ts";
import { agents } from "./agents.ts";
import { apps } from "./apps.ts";
import { candidates } from "./candidates.ts";
import { code } from "./code.ts";
import { codeEdit } from "./code-edit.ts";
import { conflicts } from "./conflicts.ts";
import { cost } from "./cost.ts";
import { deadLetters } from "./dead-letters.ts";
import { decisions } from "./decisions.ts";
import { fixtures } from "./fixtures.ts";
import { errorBody, fail, respond } from "./http.ts";
import { live } from "./live.ts";
import { members } from "./members.ts";
import { notifications } from "./notifications.ts";
import { productGraph } from "./product-graph.ts";
import { projectSettings } from "./project-settings.ts";
import { projects } from "./projects.ts";
import { releases } from "./releases.ts";
import { screenshots } from "./screenshots.ts";
import { suggestions } from "./suggestions.ts";
import { verification } from "./verification.ts";
import { workspace } from "./workspace.ts";
import { workspaceManifest } from "./workspace-manifest.ts";

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
app.route("/", members);
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
app.route("/", code);
app.route("/", codeEdit);
app.route("/", workspaceManifest);
app.route("/", productGraph);
app.route("/", deadLetters);
app.route("/", decisions);
app.route("/", notifications);
app.route("/", releases);
app.route("/", apps);
app.route("/", suggestions);
app.route("/", projectSettings);
app.route("/", projects);

app.notFound((c) => fail(c, 404, "not_found", "Route not found"));

app.onError((err, c) => {
  // Hono's validators throw HTTPException for client errors, for example malformed JSON (400).
  if (err instanceof HTTPException && err.status < 500) {
    const code =
      err.status === 401 ? "unauthorized" : err.status === 404 ? "not_found" : "invalid_request";
    return c.json(errorBody(code, err.message || "Invalid request"), err.status);
  }
  console.error(err);
  return c.json(errorBody("internal", "Internal error"), 500);
});

export default app satisfies ExportedHandler<Env>;
