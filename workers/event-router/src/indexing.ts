import type { CommandEnvelope, EventEnvelope } from "@rhumbatron/protocol";

/**
 * Index builds (AGENTS.md section 12.7). A new canonical tree, from provisioning
 * (`artifact.promoted`) or promotion (`canonical.advanced`), queues one `index.build` for
 * rhumbatron-indexer. The command ID derives from the event, so a redelivery queues the same
 * command, and the indexer builds each tree once. Deterministic: no model call.
 */
const TREE_EVENTS = new Set(["artifact.promoted", "canonical.advanced"]);

export type IndexBuildPayload = { treeSha: string; generation: number };

export function indexCommands(
  events: readonly EventEnvelope[],
): CommandEnvelope<IndexBuildPayload>[] {
  const commands: CommandEnvelope<IndexBuildPayload>[] = [];
  for (const event of events) {
    if (!TREE_EVENTS.has(event.eventType)) continue;
    const treeSha = (event.payload as { treeSha?: unknown } | null)?.treeSha;
    if (typeof treeSha !== "string" || treeSha.length === 0) continue;
    commands.push({
      commandId: `cmd_${event.eventId.slice(4)}_index`,
      commandType: "index.build",
      projectId: event.projectId,
      attempt: 0,
      createdAt: new Date().toISOString(),
      payload: { treeSha, generation: event.canonicalGeneration },
    });
  }
  return commands;
}
