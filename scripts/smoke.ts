/**
 * Remote smoke check for a deployed environment.
 * Usage: bun scripts/smoke.ts <dev|prod> [--plan]
 *
 * Public checks are read-only. When CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID are set
 * (`bun run smoke:dev` loads them from the Keychain), it also runs the authenticated flow:
 * create a Project and a Change, read them back, and check idempotency and the snapshot.
 * Each authenticated run writes about five D1 rows.
 * `--plan` also submits a real goal and waits for the Work Graph: 1 to 4 model calls (ADR 0007).
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
    type PlannedTask = { key: string; title: string; status: string; dependsOn: string[] };
    let status = "created";
    let tasks: PlannedTask[] = [];
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline && ["created", "compiling"].includes(status)) {
      await Bun.sleep(5000);
      const read = await fetch(`${target.api}/v1/changes/${changeId}`, { headers });
      status = ((await read.json()) as { data?: { status: string } }).data?.status ?? "missing";
    }
    // Give the wake consumer a moment to assign the ready Tasks.
    await Bun.sleep(5000);
    const listed = await fetch(`${target.api}/v1/changes/${changeId}/tasks`, { headers });
    tasks = ((await listed.json()) as { data?: PlannedTask[] }).data ?? [];
    report("change compiled", status === "running", `status ${status}`);
    report("work graph has tasks", tasks.length >= 2, `${tasks.length} tasks`);
    const roots = tasks.filter((t) => t.dependsOn.length === 0);
    report(
      "only root tasks dispatched",
      roots.length > 0 &&
        tasks.every(
          (t) => (t.dependsOn.length === 0) === ["ready", "assigned", "running"].includes(t.status),
        ),
    );
    for (const t of tasks)
      console.log(`      ${t.key} ${t.status.padEnd(9)} ${t.title}  deps=${t.dependsOn.length}`);
  }

  await clerk(`/sessions/${session.id}/revoke`, {});
} else {
  console.log("skip  authenticated checks (CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID not set)");
}

console.log(`\n${passed}/${passed + failed} checks passed for ${env}.`);
process.exit(failed === 0 ? 0 : 1);
