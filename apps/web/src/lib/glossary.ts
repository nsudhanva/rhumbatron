/**
 * Plain-language vocabulary for the UI (docs/ux/research-2026-10-09.md section 7.6).
 *
 * One UI label per internal concept. Code, the API and the protocol keep the internal names
 * (Candidate, ChangeSet, Intent, Canonical Generation...). The UI shows the `label` and offers
 * the one-sentence `hint` in a glossary tooltip (components/ui/term.tsx). The internal name is
 * part of the hint so a developer can map the label back to AGENTS.md section 3.
 */
export type GlossaryKey =
  | "project"
  | "change"
  | "goal"
  | "doneWhen"
  | "mustNotChange"
  | "tasks"
  | "agent"
  | "approach"
  | "codeChange"
  | "version"
  | "release"
  | "basedOn"
  | "ship"
  | "outOfDate"
  | "setAside"
  | "checks"
  | "checkResult"
  | "notRun"
  | "readyToShip"
  | "needsApproval"
  | "area"
  | "conflict"
  | "lock"
  | "concern"
  | "code"
  | "productMap"
  | "activity"
  | "eventLog"
  | "debugView"
  | "model"
  | "stuckJob"
  | "budgetPaused"
  | "risk"
  | "p95"
  | "planned"
  | "agentsWorking"
  | "shipped"
  | "yourApproval"
  | "retriedStronger"
  | "chosenAutomatically"
  | "idle"
  | "liveRelease";

export type GlossaryEntry = {
  /** The label the UI shows. */
  label: string;
  /** The internal name (AGENTS.md section 3), shown at the end of the hint. */
  internal: string;
  /** One plain sentence. */
  hint: string;
};

export const GLOSSARY: Record<GlossaryKey, GlossaryEntry> = {
  project: {
    label: "Project",
    internal: "Project",
    hint: "One app that Rhumbatron builds and ships.",
  },
  change: {
    label: "Change",
    internal: "Change",
    hint: "One goal you asked for, from plan to release.",
  },
  goal: { label: "Goal", internal: "Change.goal", hint: "What you asked for, in your words." },
  doneWhen: {
    label: "Done when",
    internal: "Acceptance criteria",
    hint: "What must be true for this change to count as done.",
  },
  mustNotChange: {
    label: "Must not change",
    internal: "Protected invariants",
    hint: "Behavior that must stay exactly as it is, for example the cart total.",
  },
  tasks: {
    label: "Tasks",
    internal: "Work Graph",
    hint: "The steps the planner split your goal into.",
  },
  agent: { label: "Agent", internal: "Agent", hint: "An AI worker that does one task." },
  approach: {
    label: "Approach",
    internal: "Intent",
    hint: "What an agent said it will change before it started.",
  },
  codeChange: {
    label: "Code change",
    internal: "ChangeSet",
    hint: "The code one task produced.",
  },
  version: {
    label: "Version",
    internal: "Candidate",
    hint: "A complete, buildable copy of the app with this change in it.",
  },
  release: {
    label: "Release",
    internal: "Canonical Generation (S<n>)",
    hint: "The live, approved state of the app.",
  },
  basedOn: {
    label: "Based on",
    internal: "Base generation",
    hint: "The release this change started from.",
  },
  ship: {
    label: "Ship",
    internal: "Promotion",
    hint: "Make this version the new release and deploy it.",
  },
  outOfDate: {
    label: "Out of date",
    internal: "Stale",
    hint: "Another change shipped first; this version must be rebuilt on top of it.",
  },
  setAside: {
    label: "Set aside",
    internal: "Candidate rejected",
    hint: "This version lost: it failed a required check.",
  },
  checks: {
    label: "Checks",
    internal: "Verification plan",
    hint: "Automatic tests that decide whether a version can ship.",
  },
  checkResult: {
    label: "Check result",
    internal: "Evidence",
    hint: "The recorded output that proves a check passed or failed.",
  },
  notRun: {
    label: "Not run",
    internal: "Coverage not_checked",
    hint: "This check did not run or timed out. It does not count as a pass.",
  },
  readyToShip: {
    label: "Ready to ship",
    internal: "Promotable",
    hint: "Every required check passed with a result.",
  },
  needsApproval: {
    label: "Needs your approval",
    internal: "Awaiting approval",
    hint: "A person must approve risky changes before they ship.",
  },
  area: {
    label: "Area",
    internal: "Semantic resource",
    hint: "A part of the product, such as wishlist membership.",
  },
  conflict: {
    label: "Conflict",
    internal: "Conflict",
    hint: "Two agents planned incompatible designs for the same area.",
  },
  lock: {
    label: "Lock",
    internal: "Claim / lease",
    hint: "An agent's temporary hold on an area so two agents do not edit it at once.",
  },
  concern: {
    label: "Concern",
    internal: "Challenge",
    hint: "A typed objection one agent raised about another's approach.",
  },
  code: {
    label: "Code",
    internal: "Workspace / Artifact / fork",
    hint: "The source code of each release and each version.",
  },
  productMap: {
    label: "Product map",
    internal: "Product Graph",
    hint: "How the parts of the product depend on each other.",
  },
  activity: { label: "Activity", internal: "Event feed", hint: "What happened, in order." },
  eventLog: {
    label: "Event log",
    internal: "Events (K2 stream)",
    hint: "The raw recorded events, for debugging.",
  },
  debugView: {
    label: "Debug view",
    internal: "Flight Control",
    hint: "Every panel at once: lanes, graph, decisions, evidence.",
  },
  model: {
    label: "Model",
    internal: "Model tier (haiku / sonnet / opus)",
    hint: "Which AI model this attempt used. Rhumbatron picks it automatically.",
  },
  stuckJob: {
    label: "Stuck job",
    internal: "Dead letter",
    hint: "A background job failed repeatedly and needs you to retry or dismiss it.",
  },
  budgetPaused: {
    label: "Paused: budget reached",
    internal: "budget_blocked",
    hint: "Spending hit the limit you set. Work is saved.",
  },
  risk: {
    label: "Risk",
    internal: "Risk tier",
    hint: "How careful the release must be; high risk needs approval.",
  },
  p95: {
    label: "Response time (p95)",
    internal: "p95Ms",
    hint: "95% of API requests were faster than this.",
  },
  planned: {
    label: "Planned",
    internal: "Work Graph compiled",
    hint: "Rhumbatron split your goal into tasks.",
  },
  agentsWorking: {
    label: "Agents working",
    internal: "Tasks running",
    hint: "AI workers are changing code, one per task.",
  },
  shipped: {
    label: "Shipped",
    internal: "Promoted and released",
    hint: "The version became the new release and was deployed.",
  },
  yourApproval: {
    label: "Your approval",
    internal: "Human gate",
    hint: "A person must approve risky changes before they ship.",
  },
  retriedStronger: {
    label: "Retried with a stronger model",
    internal: "Escalation",
    hint: "The first attempt failed, so a more capable model tried again.",
  },
  chosenAutomatically: {
    label: "Chosen automatically",
    internal: "Decided by rules or Clef",
    hint: "Rhumbatron picked the model by rule or with a small decision model.",
  },
  idle: {
    label: "Idle",
    internal: "Sleeping agent",
    hint: "Not working now; it wakes when its task is ready.",
  },
  liveRelease: {
    label: "Live release",
    internal: "Canonical State",
    hint: "The release your app runs today.",
  },
};

/** The full tooltip text: the hint, then the internal name. */
export function glossaryHint(key: GlossaryKey) {
  const entry = GLOSSARY[key];
  return `${entry.hint} Internal name: ${entry.internal}.`;
}
