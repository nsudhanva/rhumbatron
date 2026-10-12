/**
 * Remote smoke check for a deployed environment.
 * Usage: bun scripts/smoke.ts prod [--plan] [--sandbox]
 *
 * Public checks are read-only. When CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID are set
 * (set them for the prod Clerk instance), it also runs the authenticated flow:
 * create a Project and a Change, read them back, and check idempotency and the snapshot.
 * Each authenticated run writes about five D1 rows.
 * `--plan` also submits a real goal and waits for the Work Graph: 1 to 4 model calls (ADR 0021).
 * `--sandbox` creates a blank Project and adds a minimal app as a person's code edit, which
 * verifies and promotes S0 -> S1. It runs the Bun tests in the Sandbox, then verifies the canonical
 * baseline Candidate (no model calls; a few minutes of the monthly Sandbox budget, ADR 0011),
 * promotes it S1 -> S2, retries the promotion, and checks that a Candidate on S1 is then stale.
 * Every Project a run creates is archived at the end, which queues deletion of its Artifacts repos.
 */
import { signIn } from "./lib/clerk-session.ts";

const hosts: Record<string, { web: string; api: string }> = {
  prod: { web: "https://rhumbatron.com", api: "https://api.rhumbatron.com" },
};

/**
 * The smallest app in the app conventions (APP_CONVENTIONS in packages/protocol): one API route,
 * one test, the contract script, and a benchmark. `--sandbox` adds it to a blank Project as a
 * person's code edit, so the Sandbox and the checks have code to run.
 */
const SMOKE_APP: Record<string, string> = {
  "package.json": `${JSON.stringify(
    {
      name: "sandbox-smoke",
      private: true,
      type: "module",
      scripts: {
        dev: "bun run src/server.ts",
        test: "bun test",
        typecheck: "tsc --noEmit",
        bench: "bun run bench/health.bench.ts",
        contract: "bun run scripts/contract.ts",
      },
      dependencies: { hono: "4.13.13" },
      devDependencies: { "@types/bun": "1.4.2", typescript: "7.0.2" },
    },
    null,
    2,
  )}\n`,
  "tsconfig.json": `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2022"],
        types: ["bun"],
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["src", "test", "bench", "scripts"],
    },
    null,
    2,
  )}\n`,
  "wrangler.jsonc": `${JSON.stringify(
    {
      main: "src/worker.ts",
      compatibility_date: "2026-10-08",
      assets: { directory: "./public", not_found_handling: "none" },
    },
    null,
    2,
  )}\n`,
  "src/app.ts": `import { Hono } from "hono";

export function createApp() {
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ ok: true }));
  return app;
}
`,
  "src/worker.ts": `import { createApp } from "./app";

const app = createApp();

export default {
  fetch: (request: Request) => app.fetch(request),
};
`,
  "src/server.ts": `import { createApp } from "./app";

const app = createApp();
const port = Number(process.env.PORT ?? 8787);

Bun.serve({
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/api/")) return app.fetch(req);
    const file = Bun.file(pathname === "/" ? "public/index.html" : \`public\${pathname}\`);
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
`,
  "scripts/contract.ts": `const root = process.env.CONTRACT_ROOT ?? process.cwd();
const { createApp } = await import(\`\${root}/src/app.ts\`);

const app = createApp() as { routes: { method: string; path: string }[] };
const routes = [
  ...new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => \`\${r.method} \${r.path}\`)),
].sort();
process.stdout.write(\`\${JSON.stringify({ routes })}\\n\`);

export {};
`,
  "test/health.test.ts": `import { expect, test } from "bun:test";
import { createApp } from "../src/app";

test("GET /api/health answers ok", async () => {
  const response = await createApp().request("/api/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});
`,
  "bench/health.bench.ts": `import { createApp } from "../src/app";

const app = createApp();
const samples: number[] = [];
for (let i = 0; i < 2000; i++) {
  const start = performance.now();
  await app.request("/api/health");
  samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
const p95Ms = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] ?? 0;
process.stdout.write(\`\${JSON.stringify({ p95Ms })}\\n\`);
`,
  "public/index.html": `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Sandbox smoke</title></head>
  <body><h1>Sandbox smoke</h1><p>The API answers at /api/health.</p></body>
</html>
`,
};

const env = process.argv[2] ?? "prod";
const target = hosts[env];
if (!target) {
  console.error(`Usage: bun scripts/smoke.ts <${Object.keys(hosts).join("|")}>`);
  process.exit(2);
}

let passed = 0;
let failed = 0;

function report(name: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

async function expectStatus(
  name: string,
  url: string,
  status: number,
  init: RequestInit = {},
  contains?: string,
): Promise<unknown> {
  try {
    const response = await fetch(url, { redirect: "manual", ...init });
    const body = await response.text();
    const statusOk = response.status === status;
    const bodyOk = contains ? body.includes(contains) : true;
    report(
      name,
      statusOk && bodyOk,
      statusOk ? (bodyOk ? "" : `missing "${contains}"`) : `got ${response.status}`,
    );
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  } catch (error) {
    report(name, false, String(error));
    return undefined;
  }
}

// Public checks.
await expectStatus(
  "api health",
  `${target.api}/health`,
  200,
  {},
  `"service":"rhumbatron-api-${env}"`,
);
await expectStatus("api version", `${target.api}/v1/version`, 200);
await expectStatus("api unknown route", `${target.api}/smoke-not-found`, 404);
await expectStatus("api requires auth", `${target.api}/v1/projects`, 401, { method: "POST" });
await expectStatus("web home", `${target.web}/`, 200, {}, `rhumbatron-web-${env}`);
await expectStatus("web sign-in", `${target.web}/sign-in`, 200);

// Authenticated checks.
const secretKey = process.env.CLERK_SECRET_KEY;
const smokeUserId = process.env.CLERK_SMOKE_USER_ID;

if (secretKey && smokeUserId) {
  const session = await signIn(secretKey, smokeUserId);
  const jwt = await session.token();
  const headers = { authorization: `Bearer ${jwt}`, "content-type": "application/json" };
  const slug = `smoke-${Date.now()}`;

  const created = (await expectStatus("create project", `${target.api}/v1/projects`, 201, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Smoke Project", slug }),
  })) as { data?: { id: string } } | undefined;
  const projectId = created?.data?.id ?? "missing";
  // Archived at the end of the run, also when a check failed.
  const createdProjects = [projectId];

  await expectStatus("duplicate slug conflicts", `${target.api}/v1/projects`, 409, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Smoke Project", slug }),
  });
  await expectStatus("read project", `${target.api}/v1/projects/${projectId}`, 200, { headers });

  const changeBody = JSON.stringify({
    goal: "Smoke change",
    budgetUsd: 1,
    clientRequestId: `req-${slug}`,
    // Smoke runs must not spend the 50 free model requests per day.
    startPlanning: false,
  });
  const change = (await expectStatus(
    "create change",
    `${target.api}/v1/projects/${projectId}/changes`,
    201,
    {
      method: "POST",
      headers,
      body: changeBody,
    },
  )) as { data?: { id: string } } | undefined;
  const retry = (await expectStatus(
    "change retry is idempotent",
    `${target.api}/v1/projects/${projectId}/changes`,
    200,
    {
      method: "POST",
      headers,
      body: changeBody,
    },
  )) as { data?: { id: string } } | undefined;
  report("retry returns the same change", !!change?.data?.id && change.data.id === retry?.data?.id);

  await expectStatus(
    "read change",
    `${target.api}/v1/changes/${change?.data?.id ?? "missing"}`,
    200,
    { headers },
  );
  const snapshot = (await expectStatus(
    "read snapshot",
    `${target.api}/v1/projects/${projectId}/snapshot`,
    200,
    {
      headers,
    },
  )) as { data?: { sequence: number; snapshot: { activeChanges: unknown[] } } } | undefined;
  report(
    "snapshot shows the change",
    (snapshot?.data?.snapshot.activeChanges.length ?? 0) === 1 &&
      (snapshot?.data?.sequence ?? 0) >= 1,
  );

  // Cancel: the unplanned smoke Change cancels, and a repeat is a no-op.
  const cancelUrl = `${target.api}/v1/changes/${change?.data?.id ?? "missing"}/cancel`;
  type Outcome = { data?: { changeStatus?: string; repeated?: boolean } } | undefined;
  const cancelled = (await expectStatus("cancel change", cancelUrl, 200, {
    method: "POST",
    headers,
  })) as Outcome;
  report("change is cancelled", cancelled?.data?.changeStatus === "cancelled");
  const cancelledAgain = (await expectStatus("cancel is idempotent", cancelUrl, 200, {
    method: "POST",
    headers,
  })) as Outcome;
  report("repeat cancel is recorded as a repeat", cancelledAgain?.data?.repeated === true);

  await expectStatus("invalid body rejected", `${target.api}/v1/projects`, 400, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "", slug: "BAD SLUG" }),
  });

  if (process.argv.includes("--plan")) {
    const planned = (await expectStatus(
      "create planned change",
      `${target.api}/v1/projects/${projectId}/changes`,
      201,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          goal: "Make a play-money prediction market. People create yes/no markets, bet coins on an outcome, and see their coin balance. Keep API p95 below 200 ms.",
          budgetUsd: 3,
        }),
      },
    )) as { data?: { id: string } } | undefined;
    const changeId = planned?.data?.id ?? "missing";
    type PlannedTask = {
      id: string;
      key: string;
      title: string;
      status: string;
      dependsOn: string[];
    };
    // Clerk session tokens live 60 seconds; mint one per read while waiting for the planner.
    const fresh = async () => {
      const token = await session.token();
      return { authorization: `Bearer ${token}` };
    };
    let status = "created";
    let tasks: PlannedTask[] = [];
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline && ["created", "compiling"].includes(status)) {
      await Bun.sleep(5000);
      const read = await fetch(`${target.api}/v1/changes/${changeId}`, { headers: await fresh() });
      status = ((await read.json()) as { data?: { status: string } }).data?.status ?? "missing";
    }
    // Give the wake consumer a moment to assign the ready Tasks.
    await Bun.sleep(5000);
    const listed = await fetch(`${target.api}/v1/changes/${changeId}/tasks`, {
      headers: await fresh(),
    });
    tasks = ((await listed.json()) as { data?: PlannedTask[] }).data ?? [];
    report("change compiled", status === "running", `status ${status}`);
    report("work graph has tasks", tasks.length >= 2, `${tasks.length} tasks`);
    // Agents may already be running: the invariant is that no Task starts before its dependencies finish.
    const done = new Set(tasks.filter((t) => t.status === "completed").map((t) => t.id));
    report(
      "no task started before its dependencies",
      tasks.length > 0 &&
        tasks.every((t) => t.status === "pending" || t.dependsOn.every((d) => done.has(d))),
    );
    for (const t of tasks)
      console.log(`      ${t.key} ${t.status.padEnd(9)} ${t.title}  deps=${t.dependsOn.length}`);
  }

  if (process.argv.includes("--sandbox")) {
    const fresh = async () => {
      const token = await session.token();
      return { authorization: `Bearer ${token}`, "content-type": "application/json" };
    };
    const api = async <T>(method: string, path: string, body?: unknown) => {
      const response = await fetch(`${target.api}${path}`, {
        method,
        headers: await fresh(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, json: (await response.json().catch(() => ({}))) as T };
    };
    type ProjectRead = { data?: { canonical: { artifactRef: string; generation: number } } };
    type CandidateRead = {
      status: string;
      statusReason: string | null;
      gate: { promotable: boolean; gaps: { checkId: string; reason: string }[] } | null;
      composedCommit: string | null;
      approvalRequired: boolean;
      promotedGeneration: number | null;
    };
    type PromoteBody = {
      data?: {
        status: string;
        generation: number;
        fromGeneration: number;
        alreadyPromoted: boolean;
        sourceSynced: boolean;
        sourceCommit: string | null;
      };
      error?: { message: string; details?: { status?: string; reason?: string } };
    };
    /** Polls a Candidate until its checks end (verified, rejected, promoted, or stale). */
    const settle = async (candidateId: string) => {
      let read: CandidateRead | undefined;
      const until = Date.now() + 10 * 60_000;
      while (Date.now() < until) {
        await Bun.sleep(10_000);
        read = (await api<{ data?: CandidateRead }>("GET", `/v1/candidates/${candidateId}`)).json
          .data;
        if (read && !["composing", "composed", "verifying"].includes(read.status)) break;
      }
      return read;
    };
    const promote = (candidateId: string) =>
      api<PromoteBody>("POST", `/v1/candidates/${candidateId}/promote`);

    // A blank Project: one commit with a `.gitignore` (S0), the same as every product Project.
    const demo = await api<{ data?: { id: string } }>("POST", "/v1/projects", {
      name: "Sandbox Smoke",
      slug: `sandbox-${Date.now()}`,
    });
    const demoId = demo.json.data?.id ?? "missing";
    createdProjects.push(demoId);
    let source = "unassigned";
    const until = Date.now() + 120_000;
    while (source === "unassigned" && Date.now() < until) {
      await Bun.sleep(5000);
      const read = await api<ProjectRead>("GET", `/v1/projects/${demoId}`);
      source = read.json.data?.canonical.artifactRef ?? "unassigned";
    }
    report("empty repository provisioned", source !== "unassigned", source);

    // A person adds a minimal app in the app conventions through a Code page edit session. No
    // model call: the session stores the files in D1, and submit records a human ChangeSet that
    // composes and verifies like agent work (one Sandbox session).
    const opened = await api<{ data?: { sessionId: string } }>(
      "POST",
      `/v1/projects/${demoId}/code/sessions`,
    );
    const sessionId = opened.json.data?.sessionId ?? "missing";
    report("code session opened", opened.status === 201, sessionId);
    let written = 0;
    for (const [path, content] of Object.entries(SMOKE_APP)) {
      const put = await api("PUT", `/v1/code/sessions/${sessionId}/file`, { path, content });
      if (put.status === 200) written++;
    }
    const fileCount = Object.keys(SMOKE_APP).length;
    report("app files written", written === fileCount, `${written}/${fileCount}`);
    const submitted = await api<{ data?: { changeId: string; candidateIds: string[] } }>(
      "POST",
      `/v1/code/sessions/${sessionId}/submit`,
      { message: "Sandbox smoke: minimal app with GET /api/health" },
    );
    const editChange = submitted.json.data?.changeId ?? "missing";
    report("edit submitted as a Change", submitted.status === 201, editChange);
    let editCandidate = submitted.json.data?.candidateIds[0];
    const listUntil = Date.now() + 120_000;
    while (!editCandidate && Date.now() < listUntil) {
      await Bun.sleep(5000);
      const listed = await api<{ data?: { id: string }[] }>(
        "GET",
        `/v1/changes/${editChange}/candidates`,
      );
      editCandidate = listed.json.data?.[0]?.id;
    }
    const editRead = await settle(editCandidate ?? "missing");
    report(
      "edit Candidate verified",
      !!editRead && ["verified", "promoted"].includes(editRead.status),
      `${editRead?.status ?? "missing"}${editRead?.statusReason ? `: ${editRead.statusReason.slice(0, 120)}` : ""}`,
    );
    // Policy can promote a verified Candidate itself; a manual promote then reports a repeat.
    if (editRead?.status === "verified" && editRead.approvalRequired) {
      await api("POST", `/v1/changes/${editChange}/approve`, {
        candidateId: editCandidate,
        decision: "approve",
      });
    }
    const editPromoted = await promote(editCandidate ?? "missing");
    report(
      "edit promotes S0 -> S1",
      editPromoted.status === 200 &&
        editPromoted.json.data?.status === "promoted" &&
        editPromoted.json.data.generation === 1,
      editPromoted.json.error?.message ?? JSON.stringify(editPromoted.json.data),
    );

    const result = await api<{
      data?: { ok: boolean; steps: { step: string; ok: boolean; ms: number; detail: string }[] };
    }>("POST", `/v1/projects/${demoId}/sandbox-smoke`);
    for (const s of result.json.data?.steps ?? []) {
      console.log(
        `      ${s.ok ? "ok  " : "FAIL"} ${s.step} (${(s.ms / 1000).toFixed(1)} s) ${s.detail.split("\n").slice(-3).join(" | ").slice(0, 160)}`,
      );
    }
    report("sandbox runs bun test", result.json.data?.ok === true);

    // Candidate verification (P10): a Change with no ChangeSets is the canonical baseline, which
    // must pass its executable checks. No planner, no model calls; one Sandbox session.
    const baseline = await api<{ data?: { id: string } }>(
      "POST",
      `/v1/projects/${demoId}/changes`,
      {
        goal: "Baseline check. Keep GET /api/health unchanged. Keep API p95 below 200 ms.",
        budgetUsd: 1,
        startPlanning: false,
      },
    );
    const baselineChange = baseline.json.data?.id ?? "missing";
    // A second Change on S1, created before promotion. Its Candidate is created after promotion,
    // so it is stale from the start and never uses the Sandbox (its workflow stops at step 1).
    const behind = await api<{ data?: { id: string; baseGeneration: number } }>(
      "POST",
      `/v1/projects/${demoId}/changes`,
      {
        goal: "Stale baseline check. Created on S1 and promoted after S2.",
        budgetUsd: 1,
        startPlanning: false,
      },
    );
    report("second change starts on S1", behind.json.data?.baseGeneration === 1);
    const createdCandidate = await api<{ data?: { id: string } }>(
      "POST",
      `/v1/changes/${baselineChange}/candidates`,
    );
    const candidateId = createdCandidate.json.data?.id ?? "missing";
    report(
      "candidate created",
      createdCandidate.status === 202 && candidateId !== "missing",
      candidateId,
    );
    const read = await settle(candidateId);
    const evidence =
      (
        await api<{
          data?: { checkId: string; status: string; coverage: string; summary: string }[];
        }>("GET", `/v1/candidates/${candidateId}/evidence`)
      ).json.data ?? [];
    for (const e of evidence) {
      console.log(
        `      ${e.checkId.padEnd(26)} ${e.status.padEnd(7)} ${e.coverage.padEnd(18)} ${e.summary.slice(0, 90)}`,
      );
    }
    report(
      "candidate verification finished",
      !!read && ["verified", "rejected", "promoted"].includes(read.status),
      `${read?.status ?? "missing"}${read?.statusReason ? `: ${read.statusReason.slice(0, 120)}` : ""}`,
    );
    for (const checkId of ["build", "unit", "contract", "performance"]) {
      const e = evidence.find((x) => x.checkId === checkId);
      report(
        `baseline ${checkId} passes with evidence`,
        e?.status === "pass" && e.coverage === "checked_supported",
        e ? `${e.status}/${e.coverage}` : "no evidence",
      );
    }
    // The baseline adds no route, so every required check has supporting Evidence and it can
    // promote. A gap (browser, when planned) would block it: never green.
    report("gate computed", read?.gate !== null && read?.gate !== undefined);
    report(
      "baseline Candidate is promotable",
      !!read && ["verified", "promoted"].includes(read.status) && read.gate?.promotable === true,
      (read?.gate?.gaps ?? []).map((g) => `${g.checkId}:${g.reason}`).join(", ") || "no gaps",
    );

    // Promotion (P11). The human gate is policy: a baseline without a gate refuses an approval;
    // a gated Candidate needs it first (the gate itself is covered by critical tests).
    const approve = await api("POST", `/v1/changes/${baselineChange}/approve`, {
      candidateId,
      decision: "approve",
    });
    if (read?.approvalRequired) {
      report("gated baseline approval recorded", approve.status === 200, `got ${approve.status}`);
    } else {
      report("approval refused when policy has no gate", approve.status === 409);
    }
    const first = await promote(candidateId);
    report(
      "baseline promotes S1 -> S2",
      first.status === 200 &&
        first.json.data?.status === "promoted" &&
        first.json.data.fromGeneration === 1 &&
        first.json.data.generation === 2,
      first.json.error?.message ?? JSON.stringify(first.json.data),
    );
    report(
      "canonical source synced to the composed commit",
      first.json.data?.sourceSynced === true &&
        first.json.data.sourceCommit === (read?.composedCommit ?? "missing"),
      first.json.data?.sourceCommit ?? "no commit",
    );
    const retry = await promote(candidateId);
    report(
      "promotion retry is idempotent",
      retry.status === 200 &&
        retry.json.data?.alreadyPromoted === true &&
        retry.json.data.generation === 2,
      retry.json.error?.message ?? JSON.stringify(retry.json.data),
    );
    const promotedRead = await api<{ data?: CandidateRead }>(
      "GET",
      `/v1/candidates/${candidateId}`,
    );
    report(
      "candidate recorded as promoted",
      promotedRead.json.data?.status === "promoted" &&
        promotedRead.json.data.promotedGeneration === 2,
    );

    // Stale promotion: a Candidate whose base is S1 cannot promote at S2.
    const staleCreated = await api<{ data?: { id: string } }>(
      "POST",
      `/v1/changes/${behind.json.data?.id ?? "missing"}/candidates`,
    );
    const staleId = staleCreated.json.data?.id ?? "missing";
    const stale = await promote(staleId);
    report(
      "stale promotion rejected",
      stale.status === 409 && stale.json.error?.details?.status === "stale",
      stale.json.error?.message ?? `got ${stale.status}`,
    );
    const staleRead = await api<{ data?: CandidateRead }>("GET", `/v1/candidates/${staleId}`);
    report("stale candidate marked stale", staleRead.json.data?.status === "stale");
    const project = await api<ProjectRead>("GET", `/v1/projects/${demoId}`);
    report(
      "canonical generation advanced exactly twice",
      project.json.data?.canonical.generation === 2,
      `S${project.json.data?.canonical.generation ?? "?"}`,
    );
  }

  // Cleanup: archive every Project this run created. The integration Worker
  // then deletes their Artifacts repos and R2 source objects; Evidence expires by lifecycle rule.
  const freshHeaders = async () => {
    const token = await session.token();
    return { authorization: `Bearer ${token}` };
  };
  const toArchive = createdProjects.filter((id) => id !== "missing");
  const archived: string[] = [];
  for (const id of toArchive) {
    const response = await fetch(`${target.api}/v1/projects/${id}`, {
      method: "DELETE",
      headers: await freshHeaders(),
    });
    const body = (await response.json().catch(() => ({}))) as { data?: { status?: string } };
    if (response.status === 200 && body.data?.status === "archived") archived.push(id);
  }
  report(
    "archive smoke projects",
    toArchive.length > 0 && archived.length === toArchive.length,
    `${archived.length}/${toArchive.length}`,
  );
  const remaining = (
    (await (
      await fetch(`${target.api}/v1/projects?limit=200`, { headers: await freshHeaders() })
    ).json()) as { data?: { id: string }[] }
  ).data;
  report(
    "archived projects leave the project list",
    !!remaining && archived.length > 0 && !remaining.some((p) => archived.includes(p.id)),
  );

  await session.close();
} else {
  console.log("skip  authenticated checks (CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID not set)");
}

console.log(`\n${passed}/${passed + failed} checks passed for ${env}.`);
process.exit(failed === 0 ? 0 : 1);
