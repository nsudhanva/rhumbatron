/**
 * Faults that can be injected through the public dev API (AGENTS.md Phase 13). Each fault returns
 * named checks; a check that could not run is a failure, never a pass (section 34.4.1).
 * Faults that need internal hooks are listed in docs/demo/failure-injection.md instead.
 */
import { type Api, type Reply, waitFor } from "./client.ts";

export type Check = { name: string; ok: boolean; detail: string };

type Fault = {
  id: string;
  title: string;
  /** AGENTS.md sections the fault exercises. */
  sections: string;
  /** Uses Sandbox minutes (one Candidate verification). No fault calls a model. */
  sandbox: boolean;
  /** Changes shared demo state: runs only when named with `--only`. */
  explicit?: boolean;
  run(ctx: Context): Promise<Check[]>;
};

type ProjectView = { id: string; canonical: { artifactRef: string; generation: number } };
type ChangeView = { id: string; baseGeneration: number; status: string };
type CandidateView = {
  id: string;
  status: string;
  statusReason: string | null;
  approvalRequired: boolean;
  approval: { decision: string } | null;
};
type ReleaseData = {
  id: string;
  generation: number;
  status: string;
  failureReason: string | null;
  evidenceId: string | null;
  url: string | null;
};
type ReleasesData = { target: { url: string } | null; releases: ReleaseData[] };
type PromotionData = {
  status: string;
  fromGeneration: number;
  generation: number;
  alreadyPromoted: boolean;
};

const check = (name: string, ok: boolean, detail = ""): Check => ({ name, ok, detail });
const said = (reply: Reply) =>
  `${reply.status}${reply.error?.message ? ` ${reply.error.message.slice(0, 120)}` : ""}`;

/** Shared, lazily created fixtures. Every Project this run creates is archived at the end. */
export class Context {
  readonly created: string[] = [];
  private scratchId: Promise<string> | undefined;
  private seededId: Promise<string> | undefined;
  /** The Sandbox faults share one Candidate verification. */
  sandboxRun: Promise<SandboxRun> | undefined;

  constructor(
    readonly api: Api,
    readonly stamp: string,
  ) {}

  /** `acme-shop` uses the internal fixture route; `empty` is a product Project (empty repository). */
  async createProject(slug: string, template: "empty" | "acme-shop"): Promise<string> {
    const path = template === "acme-shop" ? "/v1/fixtures/projects" : "/v1/projects";
    const reply = await this.api.request<ProjectView>("POST", path, {
      name: `Inject ${slug}`,
      slug,
    });
    if (reply.status !== 201 || !reply.data) throw new Error(`create project: ${said(reply)}`);
    this.created.push(reply.data.id);
    return reply.data.id;
  }

  /** An empty Project: an empty repository (one commit), no Sandbox. */
  scratch(): Promise<string> {
    this.scratchId ??= this.createProject(`inject-${this.stamp}`, "empty");
    return this.scratchId;
  }

  /** An Acme Shop Project with its seeded source (no Sandbox; the integration Worker seeds it). */
  seeded(): Promise<string> {
    this.seededId ??= (async () => {
      const id = await this.createProject(`inject-src-${this.stamp}`, "acme-shop");
      const project = await waitFor(
        () => this.project(id),
        (p) => p.canonical.artifactRef !== "unassigned",
        { timeoutMs: 180_000, everyMs: 5_000 },
      );
      if (project.canonical.artifactRef === "unassigned") {
        throw new Error("Acme Shop source was not provisioned within 3 minutes");
      }
      return id;
    })();
    return this.seededId;
  }

  async project(id: string): Promise<ProjectView> {
    const reply = await this.api.request<ProjectView>("GET", `/v1/projects/${id}`);
    if (!reply.data) throw new Error(`read project: ${said(reply)}`);
    return reply.data;
  }

  async change(projectId: string, goal: string, clientRequestId?: string) {
    return this.api.request<ChangeView>("POST", `/v1/projects/${projectId}/changes`, {
      goal,
      budgetUsd: 1,
      // Injection never spends model calls: the Root Planner does not start.
      startPlanning: false,
      ...(clientRequestId ? { clientRequestId } : {}),
    });
  }

  candidate(id: string) {
    return this.api.request<CandidateView>("GET", `/v1/candidates/${id}`);
  }
}

type SandboxRun = {
  projectId: string;
  /** Change A: its baseline Candidate verifies in the Sandbox and promotes. */
  changeA: string;
  /** Change B: created on the same base before A promotes, so its Candidate is stale. */
  changeB: string;
  baseGeneration: number;
  candidateId: string;
  createReplies: Reply<CandidateView>[];
};

/** Creates both Changes and Candidate A, once, for every Sandbox fault. */
function sandboxRun(ctx: Context): Promise<SandboxRun> {
  ctx.sandboxRun ??= (async () => {
    const projectId = await ctx.seeded();
    const a = await ctx.change(
      projectId,
      "Inject: baseline Candidate. Keep cart behavior unchanged.",
    );
    const b = await ctx.change(projectId, "Inject: stale Candidate, created on the same base.");
    if (!a.data || !b.data) throw new Error(`create changes: ${said(a)} / ${said(b)}`);
    // Three concurrent requests for the same composition: one Candidate, one verification.
    const createReplies = await Promise.all(
      [0, 1, 2].map(() =>
        ctx.api.request<CandidateView>("POST", `/v1/changes/${a.data?.id}/candidates`),
      ),
    );
    const candidateId = createReplies.find((r) => r.data)?.data?.id;
    if (!candidateId) throw new Error(`create candidate: ${createReplies.map(said).join(", ")}`);
    return {
      projectId,
      changeA: a.data.id,
      changeB: b.data.id,
      baseGeneration: a.data.baseGeneration,
      candidateId,
      createReplies,
    };
  })();
  return ctx.sandboxRun;
}

async function verified(ctx: Context, run: SandboxRun) {
  const read = await waitFor(
    async () => (await ctx.candidate(run.candidateId)).data,
    (c) => !!c && !["composing", "composed", "verifying"].includes(c.status),
    { timeoutMs: 12 * 60_000, everyMs: 10_000 },
  );
  if (read?.status !== "verified") {
    throw new Error(
      `Candidate ${run.candidateId} is ${read?.status ?? "unreadable"}${read?.statusReason ? `: ${read.statusReason.slice(0, 120)}` : ""}`,
    );
  }
  return read;
}

/**
 * The release demo Project: `RELEASE_PROJECT_ID`, else the smoke user's `acme-shop-live` Project
 * (created by `bun run demo:live`). Only that Project has a release target (migration 0015).
 */
async function releaseProject(ctx: Context): Promise<string> {
  const fromEnv = process.env.RELEASE_PROJECT_ID;
  if (fromEnv) return fromEnv;
  const reply = await ctx.api.request<{ id: string; slug: string }[]>(
    "GET",
    "/v1/projects?limit=200",
  );
  const found = reply.data?.find((p) => p.slug === "acme-shop-live");
  if (!found) throw new Error(`no acme-shop-live Project for the smoke user (${said(reply)})`);
  return found.id;
}

export const faults: Fault[] = [
  {
    id: "change-retry",
    title: "Retried Change create returns the same Change",
    sections: "42.2, 60",
    sandbox: false,
    async run(ctx) {
      const projectId = await ctx.scratch();
      const key = `inject-retry-${ctx.stamp}`;
      const first = await ctx.change(projectId, "Inject: retried create", key);
      const retry = await ctx.change(projectId, "Inject: retried create", key);
      return [
        check("first create is 201", first.status === 201, said(first)),
        check("retry is 200, not a second 201", retry.status === 200, said(retry)),
        check(
          "retry returns the same Change ID",
          !!first.data?.id && first.data.id === retry.data?.id,
          `${first.data?.id} / ${retry.data?.id}`,
        ),
      ];
    },
  },
  {
    id: "change-double-submit",
    title: "Two concurrent Change creates with one client request ID",
    sections: "42.2, 60",
    sandbox: false,
    async run(ctx) {
      const projectId = await ctx.scratch();
      const key = `inject-double-${ctx.stamp}`;
      const goal = "Inject: double submit";
      const replies = await Promise.all([0, 1].map(() => ctx.change(projectId, goal, key)));
      const ids = new Set(replies.map((r) => r.data?.id).filter(Boolean));
      const list = await ctx.api.request<{ id: string; goal: string }[]>(
        "GET",
        `/v1/projects/${projectId}/changes`,
      );
      const stored = (list.data ?? []).filter((c) => c.goal === goal).length;
      return [
        check(
          "both requests succeed (one 201, one 200)",
          replies.every((r) => r.status === 200 || r.status === 201),
          replies.map(said).join(", "),
        ),
        check("both return one Change ID", ids.size === 1, [...ids].join(", ")),
        check("the Project stores one Change", stored === 1, `${stored} stored`),
      ];
    },
  },
  {
    id: "project-double-submit",
    title: "Two concurrent Project creates with one slug",
    sections: "42.2, 60",
    sandbox: false,
    async run(ctx) {
      const slug = `inject-slug-${ctx.stamp}`;
      const replies = await Promise.all(
        [0, 1].map(() =>
          ctx.api.request<ProjectView>("POST", "/v1/projects", {
            name: "Inject slug race",
            slug,
          }),
        ),
      );
      for (const r of replies) if (r.data?.id) ctx.created.push(r.data.id);
      const statuses = replies.map((r) => r.status).sort();
      return [
        check(
          "exactly one 201 and one 409",
          statuses[0] === 201 && statuses[1] === 409,
          replies.map(said).join(", "),
        ),
      ];
    },
  },
  {
    id: "budget-limit",
    title: "A Change budget outside policy is refused at the API",
    sections: "24, 44",
    sandbox: false,
    async run(ctx) {
      const projectId = await ctx.scratch();
      const send = (budgetUsd: number) =>
        ctx.api.request("POST", `/v1/projects/${projectId}/changes`, {
          goal: "Inject: budget limit",
          budgetUsd,
          startPlanning: false,
        });
      const [over, zero] = await Promise.all([send(1000), send(0)]);
      return [
        check("budget above the maximum is 400", over.status === 400, said(over)),
        check("zero budget is 400", zero.status === 400, said(zero)),
      ];
    },
  },
  {
    id: "candidate-without-source",
    title: "No Candidate (and no Sandbox) for a Change without ChangeSets",
    sections: "29.2, 30.5",
    sandbox: false,
    async run(ctx) {
      const projectId = await ctx.scratch();
      const change = await ctx.change(projectId, "Inject: no source");
      const id = change.data?.id ?? "missing";
      const created = await ctx.api.request("POST", `/v1/changes/${id}/candidates`);
      const list = await ctx.api.request<unknown[]>("GET", `/v1/changes/${id}/candidates`);
      return [
        check("compose is refused with 409", created.status === 409, said(created)),
        check(
          "no Candidate row was created",
          Array.isArray(list.data) && list.data.length === 0,
          said(list),
        ),
      ];
    },
  },
  {
    id: "candidate-double-submit",
    title: "Three concurrent Candidate creates for one composition",
    sections: "33, 60",
    sandbox: true,
    async run(ctx) {
      const run = await sandboxRun(ctx);
      const ids = new Set(run.createReplies.map((r) => r.data?.id));
      const list = await ctx.api.request<CandidateView[]>(
        "GET",
        `/v1/changes/${run.changeA}/candidates`,
      );
      return [
        check(
          "every request is accepted (202)",
          run.createReplies.every((r) => r.status === 202),
          run.createReplies.map(said).join(", "),
        ),
        check("all return the same Candidate ID", ids.size === 1, [...ids].join(", ")),
        check("the Change has exactly one Candidate", list.data?.length === 1, said(list)),
      ];
    },
  },
  {
    id: "early-promotion",
    title: "Promotion before verification finishes",
    sections: "36, 34.4.1",
    sandbox: true,
    async run(ctx) {
      const run = await sandboxRun(ctx);
      const before = await ctx.project(run.projectId);
      const reply = await ctx.api.request<PromotionData>(
        "POST",
        `/v1/candidates/${run.candidateId}/promote`,
      );
      const after = await ctx.project(run.projectId);
      return [
        check(
          "promotion is refused (409 blocked) while checks are missing",
          reply.status === 409 && reply.error?.details?.status === "blocked",
          said(reply),
        ),
        check(
          "the Canonical Generation did not move",
          after.canonical.generation === before.canonical.generation,
          `S${before.canonical.generation} -> S${after.canonical.generation}`,
        ),
      ];
    },
  },
  {
    id: "approval-cross-change",
    title: "Approval names a Candidate of another Change",
    sections: "40.2",
    sandbox: true,
    async run(ctx) {
      const run = await sandboxRun(ctx);
      const reply = await ctx.api.request("POST", `/v1/changes/${run.changeB}/approve`, {
        candidateId: run.candidateId,
        decision: "approve",
      });
      const read = await ctx.candidate(run.candidateId);
      return [
        check("the request is 404", reply.status === 404, said(reply)),
        check("no decision was recorded", read.data?.approval === null, said(read)),
      ];
    },
  },
  {
    id: "approval-double-submit",
    title: "Two concurrent approvals, then a conflicting decision",
    sections: "36, 40.2",
    sandbox: true,
    async run(ctx) {
      const run = await sandboxRun(ctx);
      const candidate = await verified(ctx, run);
      const path = `/v1/changes/${run.changeA}/approve`;
      const body = { candidateId: run.candidateId, decision: "approve", reason: "inject" };
      const replies = await Promise.all([0, 1].map(() => ctx.api.request("POST", path, body)));
      if (!candidate.approvalRequired) {
        const after = await ctx.candidate(run.candidateId);
        return [
          check(
            "both are refused (409 not_required): policy has no gate here",
            replies.every((r) => r.status === 409 && r.error?.details?.reason === "not_required"),
            replies.map(said).join(", "),
          ),
          check("no decision was recorded", after.data?.approval === null, said(after)),
        ];
      }
      const reject = await ctx.api.request("POST", path, { ...body, decision: "reject" });
      const after = await ctx.candidate(run.candidateId);
      return [
        check(
          "both are recorded as one decision (identical repeat accepted)",
          replies.every((r) => r.status === 200),
          replies.map(said).join(", "),
        ),
        check(
          "a conflicting decision is refused (409 already_decided)",
          reject.status === 409 && reject.error?.details?.reason === "already_decided",
          said(reject),
        ),
        check("the first decision stands", after.data?.approval?.decision === "granted"),
      ];
    },
  },
  {
    id: "promotion-double-submit",
    title: "Two concurrent promotions of one verified Candidate",
    sections: "36, 42.9, 60",
    sandbox: true,
    async run(ctx) {
      const run = await sandboxRun(ctx);
      await verified(ctx, run);
      const replies = await Promise.all(
        [0, 1].map(() =>
          ctx.api.request<PromotionData>("POST", `/v1/candidates/${run.candidateId}/promote`),
        ),
      );
      const firsts = replies.filter((r) => r.data?.alreadyPromoted === false).length;
      const project = await ctx.project(run.projectId);
      return [
        check(
          "both return 200 promoted",
          replies.every((r) => r.status === 200 && r.data?.status === "promoted"),
          replies.map(said).join(", "),
        ),
        check("exactly one is the first promotion", firsts === 1, `${firsts} first promotions`),
        check(
          "the Canonical Generation advanced exactly once",
          project.canonical.generation === run.baseGeneration + 1,
          `S${run.baseGeneration} -> S${project.canonical.generation}`,
        ),
      ];
    },
  },
  {
    id: "stale-candidate",
    title: "A Candidate on the old base after another promotion",
    sections: "13.1, 36, 42.9",
    sandbox: true,
    async run(ctx) {
      const run = await sandboxRun(ctx);
      const project = await ctx.project(run.projectId);
      if (project.canonical.generation === run.baseGeneration) {
        return [check("Change A promoted first", false, "run promotion-double-submit first")];
      }
      // Its verification workflow stops at step 1 (stale base), so it never opens the Sandbox.
      const created = await ctx.api.request<CandidateView>(
        "POST",
        `/v1/changes/${run.changeB}/candidates`,
      );
      const staleId = created.data?.id ?? "missing";
      const reply = await ctx.api.request("POST", `/v1/candidates/${staleId}/promote`);
      const read = await ctx.candidate(staleId);
      const after = await ctx.project(run.projectId);
      return [
        check(
          "promotion is refused (409 stale)",
          reply.status === 409 && reply.error?.details?.status === "stale",
          said(reply),
        ),
        check("the Candidate is marked stale", read.data?.status === "stale", read.data?.status),
        check(
          "the Canonical Generation did not move again",
          after.canonical.generation === project.canonical.generation,
          `S${after.canonical.generation}`,
        ),
      ];
    },
  },
  {
    // P13-12. Honest failure: the release URL is really probed, including a route that does not
    // exist; its 404 fails the smoke check through the normal failure path, marked injected.
    id: "release-smoke-failure",
    title: "A deployed release fails its smoke check (injected missing route)",
    sections: "21.3, 42.10",
    sandbox: false,
    explicit: true,
    async run(ctx) {
      const projectId = await releaseProject(ctx);
      const before = await ctx.project(projectId);
      const listed = await ctx.api.request<ReleasesData>(
        "GET",
        `/v1/projects/${projectId}/releases?limit=1`,
      );
      const latest = listed.data?.releases[0];
      if (!listed.data?.target || !latest) {
        return [check("a deployed release exists", false, said(listed))];
      }
      const reply = await ctx.api.request<{ status: string; release: ReleaseData }>(
        "POST",
        `/v1/projects/${projectId}/releases/inject-failure`,
      );
      const again = await ctx.api.request<{ status: string; repeated: boolean }>(
        "POST",
        `/v1/projects/${projectId}/releases/inject-failure`,
      );
      const after = await ctx.project(projectId);
      const release = reply.data?.release;
      return [
        check("injection is recorded (200)", reply.status === 200, said(reply)),
        check(
          "the latest release is smoke_failed with injected Evidence",
          release?.id === latest.id &&
            release.status === "smoke_failed" &&
            !!release.evidenceId?.endsWith("-injected") &&
            !!release.failureReason?.startsWith("Injected"),
          `${release?.status ?? "none"} ${release?.evidenceId ?? ""}`,
        ),
        check(
          "a repeat changes nothing",
          again.status === 200 && again.data?.repeated === true,
          said(again),
        ),
        check(
          "the Canonical Generation did not move (recovery is a new promotion)",
          after.canonical.generation === before.canonical.generation,
          `S${before.canonical.generation} -> S${after.canonical.generation}`,
        ),
      ];
    },
  },
];
