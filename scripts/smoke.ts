/**
 * Remote smoke check for a deployed environment.
 * Usage: bun scripts/smoke.ts <dev|prod> [--plan]
 *
 * Public checks are read-only. When CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID are set
 * (`bun run smoke:dev` loads them from the Keychain), it also runs the authenticated flow:
 * create a Project and a Change, read them back, and check idempotency and the snapshot.
 * Each authenticated run writes about five D1 rows.
 * `--plan` also submits a real goal and waits for the Work Graph: 1 to 4 model calls (ADR 0007).
 * `--sandbox` seeds an Acme Shop project and runs its Bun tests in the Sandbox, then verifies the
 * canonical baseline Candidate (no model calls; a few minutes of the monthly Sandbox budget, ADR 0011),
 * promotes it S0 -> S1, retries the promotion, and checks that a Candidate on S0 is then stale.
 * Every Project a run creates is archived at the end, which queues deletion of its Artifacts repos.
 */

const hosts: Record<string, { web: string; api: string }> = {
  dev: { web: "https://dev.rhumbatron.com", api: "https://api-dev.rhumbatron.com" },
  prod: { web: "https://rhumbatron.com", api: "https://api.rhumbatron.com" },
};

const env = process.argv[2] ?? "dev";
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

async function clerk<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`https://api.clerk.com/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Clerk ${path} returned ${response.status}`);
  return (await response.json()) as T;
}

if (secretKey && smokeUserId) {
  const session = await clerk<{ id: string }>("/sessions", { user_id: smokeUserId });
  const { jwt } = await clerk<{ jwt: string }>(`/sessions/${session.id}/tokens`, {});
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
          goal: "Add shared wishlists. Users can create a wishlist, share it with a link, and let collaborators add or remove products. Keep existing cart behavior unchanged. Keep API p95 below 200 ms.",
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
      const { jwt: token } = await clerk<{ jwt: string }>(`/sessions/${session.id}/tokens`, {});
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
      const { jwt: token } = await clerk<{ jwt: string }>(`/sessions/${session.id}/tokens`, {});
      return { authorization: `Bearer ${token}`, "content-type": "application/json" };
    };
    const demo = (await (
      await fetch(`${target.api}/v1/projects`, {
        method: "POST",
        headers: await fresh(),
        body: JSON.stringify({
          name: "Sandbox Smoke",
          slug: `sandbox-${Date.now()}`,
          template: "acme-shop",
        }),
      })
    ).json()) as { data?: { id: string } };
    const demoId = demo.data?.id ?? "missing";
    createdProjects.push(demoId);
    let source = "unassigned";
    const until = Date.now() + 120_000;
    while (source === "unassigned" && Date.now() < until) {
      await Bun.sleep(5000);
      const read = (await (
        await fetch(`${target.api}/v1/projects/${demoId}`, { headers: await fresh() })
      ).json()) as {
        data?: { canonical: { artifactRef: string } };
      };
      source = read.data?.canonical.artifactRef ?? "unassigned";
    }
    report("acme source provisioned", source !== "unassigned", source);
    const result = (await (
      await fetch(`${target.api}/v1/projects/${demoId}/sandbox-smoke`, {
        method: "POST",
        headers: await fresh(),
      })
    ).json()) as {
      data?: { ok: boolean; steps: { step: string; ok: boolean; ms: number; detail: string }[] };
    };
    for (const s of result.data?.steps ?? []) {
      console.log(
        `      ${s.ok ? "ok  " : "FAIL"} ${s.step} (${(s.ms / 1000).toFixed(1)} s) ${s.detail.split("\n").slice(-3).join(" | ").slice(0, 160)}`,
      );
    }
    report("sandbox runs bun test", result.data?.ok === true);

    // Candidate verification (P10): a Change with no ChangeSets is the canonical baseline, which
    // must pass its executable checks. No planner, no model calls; one Sandbox session.
    const baseline = (await (
      await fetch(`${target.api}/v1/projects/${demoId}/changes`, {
        method: "POST",
        headers: await fresh(),
        body: JSON.stringify({
          goal: "Baseline check. Keep existing cart behavior unchanged. Keep API p95 below 200 ms.",
          budgetUsd: 1,
          startPlanning: false,
        }),
      })
    ).json()) as { data?: { id: string } };
    const baselineChange = baseline.data?.id ?? "missing";
    // A second Change on S0, created before promotion. Its Candidate is created after promotion,
    // so it is stale from the start and never uses the Sandbox (its workflow stops at step 1).
    const behind = (await (
      await fetch(`${target.api}/v1/projects/${demoId}/changes`, {
        method: "POST",
        headers: await fresh(),
        body: JSON.stringify({
          goal: "Stale baseline check. Created on S0 and promoted after S1.",
          budgetUsd: 1,
          startPlanning: false,
        }),
      })
    ).json()) as { data?: { id: string; baseGeneration: number } };
    report("second change starts on S0", behind.data?.baseGeneration === 0);
    const createdCandidate = await fetch(`${target.api}/v1/changes/${baselineChange}/candidates`, {
      method: "POST",
      headers: await fresh(),
    });
    const candidate = ((await createdCandidate.json()) as { data?: { id: string } }).data;
    report("candidate created", createdCandidate.status === 202 && !!candidate?.id, candidate?.id);
    type CandidateRead = {
      status: string;
      statusReason: string | null;
      gate: { promotable: boolean; gaps: { checkId: string; reason: string }[] } | null;
      composedCommit: string | null;
      approvalRequired: boolean;
      promotedGeneration: number | null;
    };
    let read: CandidateRead | undefined;
    const verifyUntil = Date.now() + 10 * 60_000;
    while (Date.now() < verifyUntil) {
      await Bun.sleep(10_000);
      const response = await fetch(`${target.api}/v1/candidates/${candidate?.id ?? "missing"}`, {
        headers: await fresh(),
      });
      read = ((await response.json()) as { data?: CandidateRead }).data;
      if (read && !["composing", "composed", "verifying"].includes(read.status)) break;
    }
    const evidence =
      (
        (await (
          await fetch(`${target.api}/v1/candidates/${candidate?.id ?? "missing"}/evidence`, {
            headers: await fresh(),
          })
        ).json()) as {
          data?: { checkId: string; status: string; coverage: string; summary: string }[];
        }
      ).data ?? [];
    for (const e of evidence) {
      console.log(
        `      ${e.checkId.padEnd(26)} ${e.status.padEnd(7)} ${e.coverage.padEnd(18)} ${e.summary.slice(0, 90)}`,
      );
    }
    report(
      "candidate verification finished",
      !!read && ["verified", "rejected"].includes(read.status),
      `${read?.status ?? "missing"}${read?.statusReason ? `: ${read.statusReason.slice(0, 120)}` : ""}`,
    );
    for (const checkId of [
      "build",
      "unit",
      "contract",
      "protected-invariant-cart",
      "performance",
    ]) {
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
      read?.status === "verified" && read.gate?.promotable === true,
      (read?.gate?.gaps ?? []).map((g) => `${g.checkId}:${g.reason}`).join(", ") || "no gaps",
    );

    // Promotion (P11). The human gate is policy: a medium-risk baseline has none, so an approval is
    // refused; a gated Candidate would need it first (the gate itself is covered by critical tests).
    const candidateId = candidate?.id ?? "missing";
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
    const approve = await fetch(`${target.api}/v1/changes/${baselineChange}/approve`, {
      method: "POST",
      headers: await fresh(),
      body: JSON.stringify({ candidateId, decision: "approve" }),
    });
    if (read?.approvalRequired) {
      report("gated baseline approval recorded", approve.status === 200, `got ${approve.status}`);
    } else {
      report("approval refused when policy has no gate", approve.status === 409);
    }
    const promote = async () => {
      const response = await fetch(`${target.api}/v1/candidates/${candidateId}/promote`, {
        method: "POST",
        headers: await fresh(),
      });
      return { status: response.status, body: (await response.json()) as PromoteBody };
    };
    const first = await promote();
    report(
      "baseline promotes S0 -> S1",
      first.status === 200 &&
        first.body.data?.status === "promoted" &&
        first.body.data.fromGeneration === 0 &&
        first.body.data.generation === 1 &&
        first.body.data.alreadyPromoted === false,
      first.body.error?.message ?? JSON.stringify(first.body.data),
    );
    report(
      "canonical source synced to the composed commit",
      first.body.data?.sourceSynced === true &&
        first.body.data.sourceCommit === (read?.composedCommit ?? "missing"),
      first.body.data?.sourceCommit ?? "no commit",
    );
    const retry = await promote();
    report(
      "promotion retry is idempotent",
      retry.status === 200 &&
        retry.body.data?.alreadyPromoted === true &&
        retry.body.data.generation === 1,
      retry.body.error?.message ?? JSON.stringify(retry.body.data),
    );
    const promotedRead = (await (
      await fetch(`${target.api}/v1/candidates/${candidateId}`, { headers: await fresh() })
    ).json()) as { data?: CandidateRead };
    report(
      "candidate recorded as promoted",
      promotedRead.data?.status === "promoted" && promotedRead.data.promotedGeneration === 1,
    );

    // Stale promotion (sections 36, 42.9): a Candidate whose base is S0 cannot promote at S1.
    const staleCreated = await fetch(
      `${target.api}/v1/changes/${behind.data?.id ?? "missing"}/candidates`,
      { method: "POST", headers: await fresh() },
    );
    const staleId =
      ((await staleCreated.json()) as { data?: { id: string } }).data?.id ?? "missing";
    const stale = await (async () => {
      const response = await fetch(`${target.api}/v1/candidates/${staleId}/promote`, {
        method: "POST",
        headers: await fresh(),
      });
      return { status: response.status, body: (await response.json()) as PromoteBody };
    })();
    report(
      "stale promotion rejected",
      stale.status === 409 && stale.body.error?.details?.status === "stale",
      stale.body.error?.message ?? `got ${stale.status}`,
    );
    const staleRead = (await (
      await fetch(`${target.api}/v1/candidates/${staleId}`, { headers: await fresh() })
    ).json()) as { data?: CandidateRead };
    report("stale candidate marked stale", staleRead.data?.status === "stale");
    const project = (await (
      await fetch(`${target.api}/v1/projects/${demoId}`, { headers: await fresh() })
    ).json()) as { data?: { canonical: { generation: number } } };
    report(
      "canonical generation advanced exactly once",
      project.data?.canonical.generation === 1,
      `S${project.data?.canonical.generation ?? "?"}`,
    );
  }

  // Cleanup (AGENTS.md section 43): archive every Project this run created. The integration Worker
  // then deletes their Artifacts repos and R2 source objects; Evidence expires by lifecycle rule.
  const freshHeaders = async () => {
    const { jwt: token } = await clerk<{ jwt: string }>(`/sessions/${session.id}/tokens`, {});
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

  await clerk(`/sessions/${session.id}/revoke`, {});
} else {
  console.log("skip  authenticated checks (CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID not set)");
}

console.log(`\n${passed}/${passed + failed} checks passed for ${env}.`);
process.exit(failed === 0 ? 0 : 1);
