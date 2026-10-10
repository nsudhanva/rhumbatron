import type { ContextItem, ContextPacket } from "@rhumbatron/protocol";
import type { Retrieval, RetrievedFile } from "./retrieval.ts";

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
    /** Original evidence retained even if the optional failure text is dropped. */
    sourceRefs?: string[];
  }[];
  /** Validated prior-log summary. The source references are required provenance, never trimmed. */
  compaction?: {
    sourceHash: string;
    summary: string;
    errors: string[];
    files: string[];
    sourceRefs: string[];
    r2Key: string;
  };
  /** Canonical source files (paths only). Agents read contents with tools, not from the packet. */
  repository?: { commit: string; files: string[] };
  /**
   * Dependency ChangeSets merged, in this order, onto the canonical commit before the agent's first
   * edit (stacked workspace). Facts from stored ChangeSets only: IDs, commits, and changed files.
   */
  inheritedChangeSets?: {
    changeSetId: string;
    taskKey: string;
    title: string;
    commit: string;
    files: string[];
  }[];
  /**
   * Indexed retrieval for the canonical tree (section 27.3): declared files, dependency neighbors,
   * resource owners, and Vectorize matches. Absent when the tree has no index yet.
   */
  retrieval?: Retrieval | null;
  /**
   * The Project is a live app (ADR 0020): generated apps never get a real login. Adds the fake
   * identity rule to the packet as a required policy item.
   */
  appRules?: boolean;
  allowedTools: string[];
  budget: { maxModelCalls: number; budgetUsd: number };
  /** Hard ceiling for the rendered items. Lower-priority items are dropped first. */
  maxTokens: number;
};

/** The live app identity rule (ADR 0020, docs/plans/phase-16-live-apps.md section 4.3). */
const FAKE_IDENTITY_RULE =
  "Use the fake identity module for any auth need. Never add real authentication or collect credentials.";

/** Files listed per inherited ChangeSet; the rest are counted. */
const MAX_INHERITED_FILES = 40;

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
  if (input.appRules) {
    required.push({
      itemId: "policy:fake-identity",
      source: "policy",
      sourceVersion: "adr-0020",
      capturedAt: now,
      title: "Live app rule: fake identity only",
      body: `${FAKE_IDENTITY_RULE} The app runs on a public host with no real login: accounts, sign-in, and roles are a demo user picker stored in a cookie on the app's own host (src/identity.ts in the template). No passwords, no email, no third-party auth SDKs; the build rejects them.`,
    });
  }
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
  const inherited = input.inheritedChangeSets ?? [];
  if (inherited.length > 0) {
    required.push({
      itemId: `stack:${task.id}`,
      source: "dependency_changeset",
      sourceVersion: inherited.map((c) => c.commit).join(","),
      capturedAt: now,
      title: `Inherited upstream work (${inherited.length} ChangeSet${inherited.length === 1 ? "" : "s"})`,
      body: [
        "These upstream ChangeSets are merged, in this order, on top of the repository commit above. read_file and list_files show the merged result. Extend these files; do not re-create them.",
        ...inherited.map((c) => {
          const shown = c.files.slice(0, MAX_INHERITED_FILES);
          const more = c.files.length - shown.length;
          return `${c.taskKey || c.changeSetId} (${c.title}): ChangeSet ${c.changeSetId} at commit ${c.commit.slice(0, 12)}, files changed from the repository commit:\n${bullets(shown)}${more > 0 ? `\n- … ${more} more` : ""}`;
        }),
      ].join("\n\n"),
    });
  }
  if (input.compaction) {
    const compact = input.compaction;
    required.push({
      itemId: `compaction:${compact.sourceHash}`,
      source: "compaction",
      sourceVersion: compact.sourceHash,
      capturedAt: now,
      title: "Prior attempts and tool logs (compact summary)",
      body: [
        compact.summary,
        `Exact errors:\n${bullets(compact.errors)}`,
        `Files touched:\n${bullets(compact.files)}`,
        `Original source references (retained):\n${bullets(compact.sourceRefs)}`,
        `Stored summary: ${compact.r2Key}`,
      ].join("\n\n"),
    });
  } else {
    for (const failure of input.priorFailures) {
      if (!failure.sourceRefs?.length) continue;
      required.push({
        itemId: `failure-evidence:${failure.runId}`,
        source: "prior_failure",
        sourceVersion: failure.runId,
        capturedAt: now,
        title: `Original evidence for earlier attempt ${failure.attempt}`,
        body: bullets(failure.sourceRefs),
      });
    }
  }
  const retrieval = input.retrieval ?? null;
  const fileItem =
    (prefix: string, label: string) =>
    (f: RetrievedFile): ContextItem => ({
      itemId: `${prefix}:${f.path}`,
      source: "file",
      sourceVersion: retrieval?.treeSha ?? "",
      capturedAt: now,
      title: `${label} ${f.path} (${f.reason})`,
      body: f.summary,
    });
  const tier = (t: RetrievedFile["tier"]) => (retrieval?.files ?? []).filter((f) => f.tier === t);
  // Section 27.3 order: declared files, dependency neighbors, resource owners, recent events
  // (Intents and failures), then Vectorize matches last, so they are trimmed first.
  const optional: ContextItem[] = [
    ...tier("declared").map(fileItem("file", "Declared file")),
    ...tier("dependency").map(fileItem("dep", "Dependency")),
    ...(retrieval?.owners ?? []).map(
      (o): ContextItem => ({
        itemId: `owner:${o.resource}`,
        source: "product_graph",
        sourceVersion: retrieval?.treeSha ?? "",
        capturedAt: now,
        title: `Files that own ${o.resource} (Product Graph)`,
        body: bullets(o.files),
      }),
    ),
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
    ...(input.compaction ? [] : input.priorFailures).map(
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
    ...tier("semantic").map(fileItem("semantic", "Possibly related file")),
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
