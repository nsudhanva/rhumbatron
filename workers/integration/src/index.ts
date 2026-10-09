import { AnyCommandEnvelope } from "@rhumbatron/protocol";
import { dispatchReadyTasks } from "./dispatch.ts";

export { ChangeWorkflow } from "./change-workflow.ts";

type ChangeRow = {
  project_id: string;
  org_id: string;
  slug: string;
  base_generation: number;
  budget_usd: number;
};

/** Handles one `change.dispatch` command. Unknown commands and Changes are acknowledged and dropped. */
async function handleCommand(env: Env, body: unknown) {
  const command = AnyCommandEnvelope.safeParse(body);
  if (!command.success || command.data.commandType !== "change.dispatch") return;
  const { changeId } = command.data;
  const row = await env.DB.prepare(
    `SELECT c.project_id, p.org_id, p.slug, c.base_generation, c.budget_usd
     FROM changes c JOIN projects p ON p.id = c.project_id WHERE c.id = ? AND c.status = 'running'`,
  )
    .bind(changeId)
    .first<ChangeRow>();
  if (!row) return;
  await dispatchReadyTasks(
    env,
    {
      projectId: row.project_id,
      orgId: row.org_id,
      projectSlug: row.slug,
      changeId,
      baseGeneration: row.base_generation,
    },
    row.budget_usd,
  );
}

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
        await handleCommand(env, message.body);
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({ event: "dispatch.failed", message: String(error).slice(0, 200) }),
        );
        message.retry({ delaySeconds: 30 });
      }
    }
  },
} satisfies ExportedHandler<Env>;
