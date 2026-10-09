import { handleWake } from "./wake-consumer.ts";

export { AgentDO } from "./agent-do.ts";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: env.SERVICE_NAME, environment: env.ENVIRONMENT });
    }
    return new Response("Not Found", { status: 404 });
  },

  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      try {
        // Invalid and stale wakes are acknowledged: retrying them cannot succeed.
        await handleWake(env, message.body);
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({ event: "wake.failed", message: String(error).slice(0, 200) }),
        );
        // Bounded retries, then the dead-letter Queue (AGENTS.md section 42.7).
        message.retry({ delaySeconds: 30 });
      }
    }
  },
} satisfies ExportedHandler<Env>;
