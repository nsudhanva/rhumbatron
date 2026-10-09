import type { ContextItem, ContextPacket } from "@rhumbatron/protocol";

/**
 * Context Compiler (AGENTS.md section 27): deterministic, no model calls, no I/O. Callers load the
 * inputs; this module orders them by retrieval priority (section 27.3), trims to the token budget,
 * and renders the packet the agent sees.
 */

/** Rough, deterministic token estimate (about 4 characters per token). Good enough for budgets. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export type IntentInput = {
  taskId: string;
  taskKey: string;
  title: string;
  runId: string;
  endedAt: string;
  resources: string[];
  intent: Record<string, unknown>;
};

export type CompileInput = {
  projectId: string;
  canonicalGeneration: number;
  now: string;
  change: {
    id: string;
    goal: string;
    acceptanceCriteria: string[];
    invariants: string[];
    updatedAt: string;
  };
  task: {
    id: string;
    key: string;
    kind: string;
    title: string;
    objective: string;
    riskTier: string;
    acceptanceCriteria: string[];
    semanticResources: string[];
    updatedAt: string;
  };
  /** Intents of the Task's exact dependencies (completed upstream Tasks). */
  dependencyIntents: IntentInput[];
  /** Intents of other completed Tasks in the Change that share a semantic resource. */
  nearbyIntents: IntentInput[];
  priorFailures: {
    runId: string;
    attempt: number;
    tier: string;
    kind: string;
    reason: string;
    endedAt: string;
  }[];
  /** Canonical source files (paths only). Agents read contents with tools, not from the packet. */
  repository?: { commit: string; files: string[] };
  allowedTools: string[];
  budget: { maxModelCalls: number; budgetUsd: number };
  /** Hard ceiling for the rendered items. Lower-priority items are dropped first. */
  maxTokens: number;
};

const bullets = (items: readonly string[]) => items.map((s) => `- ${s}`).join("\n") || "- none";

function intentBody(i: IntentInput): string {
  const intent = i.intent;
  const list = (key: string) =>
    Array.isArray(intent[key]) ? bullets(intent[key] as string[]) : "- none";
  return [
    String(intent.summary ?? ""),
    `Files:\n${list("expectedFiles")}`,
    `Contract changes:\n${list("expectedContractChanges")}`,
    `Data changes:\n${list("expectedDataChanges")}`,
    `Assumptions:\n${list("assumptions")}`,
  ].join("\n");
}

/** Builds the packet. Items are in priority order; the lowest-priority items are trimmed first. */
export function compilePacket(input: CompileInput): ContextPacket {
  const { change, task, now } = input;
  const required: ContextItem[] = [
    {
      itemId: `change:${change.id}`,
      source: "change",
      sourceVersion: change.updatedAt,
      capturedAt: now,
      title: "Change goal",
      body: `${change.goal}\n\nAcceptance criteria:\n${bullets(change.acceptanceCriteria)}\n\nInvariants that must not change:\n${bullets(change.invariants)}`,
    },
    {
      itemId: `task:${task.id}`,
      source: "task",
      sourceVersion: task.updatedAt,
      capturedAt: now,
      title: `Your Task ${task.key} (${task.kind}, risk ${task.riskTier}): ${task.title}`,
      body: `Objective: ${task.objective}\n\nSemantic resources:\n${bullets(task.semanticResources)}\n\nAcceptance criteria:\n${bullets(task.acceptanceCriteria)}`,
    },
  ];
  if (input.repository) {
    const shown = input.repository.files.slice(0, 300);
    required.push({
      itemId: `repo:${input.repository.commit}`,
      source: "file",
      sourceVersion: input.repository.commit,
      capturedAt: now,
      title: `Repository at commit ${input.repository.commit.slice(0, 12)} (${input.repository.files.length} files)`,
      body: `${shown.join("\n")}${input.repository.files.length > shown.length ? "\n…" : ""}\n\nRead files with read_file before declaring changes to them.`,
    });
  }
  const optional: ContextItem[] = [
    ...input.dependencyIntents.map(
      (i): ContextItem => ({
        itemId: `intent:${i.runId}`,
        source: "dependency_intent",
        sourceVersion: i.runId,
        capturedAt: now,
        title: `Upstream ${i.taskKey} (${i.title}) declared`,
        body: intentBody(i),
      }),
    ),
    ...input.priorFailures.map(
      (f): ContextItem => ({
        itemId: `failure:${f.runId}`,
        source: "prior_failure",
        sourceVersion: f.runId,
        capturedAt: now,
        title: `Earlier attempt ${f.attempt} on ${f.tier} failed (${f.kind})`,
        body: f.reason,
      }),
    ),
    ...input.nearbyIntents.map(
      (i): ContextItem => ({
        itemId: `intent:${i.runId}`,
        source: "nearby_intent",
        sourceVersion: i.runId,
        capturedAt: now,
        title: `Parallel ${i.taskKey} (${i.title}) on ${i.resources.join(", ")} declared`,
        body: intentBody(i),
      }),
    ),
  ];

  const items = [...required];
  let used = required.reduce((n, item) => n + estimateTokens(item.title + item.body), 0);
  for (const item of optional) {
    const cost = estimateTokens(item.title + item.body);
    if (used + cost > input.maxTokens) continue;
    items.push(item);
    used += cost;
  }

  return {
    packetVersion: 1,
    projectId: input.projectId,
    changeId: change.id,
    taskId: task.id,
    canonicalGeneration: input.canonicalGeneration,
    allowedTools: input.allowedTools,
    relevantResources: task.semanticResources,
    items,
    budget: input.budget,
    tokenEstimate: used,
  };
}

/** The packet as prompt text. Item IDs are shown so findings can cite them (section 34.4.2). */
export function renderPacket(packet: ContextPacket): string {
  return packet.items.map((item) => `## ${item.title} [${item.itemId}]\n${item.body}`).join("\n\n");
}

/** SHA-256 of the packet JSON: the Evidence Snapshot key (section 27.5). */
export async function packetHash(packet: ContextPacket): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(packet));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
