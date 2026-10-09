import { WorkerEntrypoint } from "cloudflare:workers";
import { resolveDeadLetter } from "@rhumbatron/integration/dead-letters";
import { type SandboxSmokeResult, sandboxSmoke } from "./sandbox-smoke.ts";
import { handleWake } from "./wake-consumer.ts";

export { AgentDO } from "./agent-do.ts";

export default class Agents extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: this.env.SERVICE_NAME,
        environment: this.env.ENVIRONMENT,
      });
    }
    return new Response("Not Found", { status: 404 });
  }

  /** Service-binding RPC for the API's Sandbox smoke check (no model calls). */
  async sandboxSmoke(projectId: string): Promise<SandboxSmokeResult> {
    return sandboxSmoke(this.env, projectId);
  }

  override async queue(batch: MessageBatch): Promise<void> {
    const env = this.env;
    for (const message of batch.messages) {
      try {
        // Invalid and stale wakes are acknowledged: retrying them cannot succeed.
        await handleWake(env, message.body);
        await resolveDeadLetter(env.DB, message.body);
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({ event: "wake.failed", message: String(error).slice(0, 200) }),
        );
        // Bounded retries, then the dead-letter Queue (AGENTS.md section 42.7).
        message.retry({ delaySeconds: 30 });
      }
    }
  }
}
