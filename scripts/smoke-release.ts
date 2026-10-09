/**
 * Release smoke check (P11-09; AGENTS.md sections 21.3, 37; ADR 0018).
 * Usage: bun run smoke:release [dev|prod] [--project <id>]
 *
 * Reads the release Project's latest release row through the API (as the Clerk smoke user, the
 * same Keychain items as `bun run smoke:dev`) and probes its release URL with the same probes the
 * ReleaseWorkflow runs: the app shell and the products API. Read-only: no row is written, no build
 * starts. The Project defaults to the smoke user's `acme-shop-live` (created by `bun run demo:live`).
 */

import { classifySmoke, runProbes, smokeProbes } from "../workers/integration/src/release-model.ts";
import { connect } from "./inject/client.ts";

const apis: Record<string, string> = {
  dev: "https://api-dev.rhumbatron.com",
  prod: "https://api.rhumbatron.com",
};

const args = process.argv.slice(2);
const environment = args.find((a) => !a.startsWith("--") && apis[a]) ?? "dev";
const projectFlag = args.indexOf("--project");
const projectArg = projectFlag >= 0 ? args[projectFlag + 1] : process.env.RELEASE_PROJECT_ID;

const secretKey = process.env.CLERK_SECRET_KEY;
const userId = process.env.CLERK_SMOKE_USER_ID;
if (!secretKey || !userId) {
  console.error(
    "CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID are required (use `bun run smoke:release`).",
  );
  process.exit(2);
}

type Release = {
  id: string;
  generation: number;
  status: string;
  versionId: string | null;
  evidenceId: string | null;
  failureReason: string | null;
};
type Releases = { target: { workerName: string; url: string } | null; releases: Release[] };

let failed = 0;
function report(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

const api = await connect(apis[environment] as string, secretKey, userId);
try {
  let projectId = projectArg;
  if (!projectId) {
    const list = await api.request<{ id: string; slug: string }[]>("GET", "/v1/projects?limit=200");
    projectId = list.data?.find((p) => p.slug === "acme-shop-live")?.id;
  }
  if (!projectId) {
    report("release Project found", false, "no acme-shop-live Project; pass --project <id>");
  } else {
    const reply = await api.request<Releases>("GET", `/v1/projects/${projectId}/releases?limit=5`);
    const target = reply.data?.target ?? null;
    report("release target exists", !!target, target ? target.url : `${reply.status}`);
    const latest = reply.data?.releases.find((r) => r.status !== "superseded");
    report(
      "latest release is deployed",
      latest?.status === "deployed",
      latest
        ? `S${latest.generation} ${latest.status}${latest.failureReason ? `: ${latest.failureReason.slice(0, 160)}` : ""}`
        : "no release yet",
    );
    report("deployed version recorded", !!latest?.versionId, latest?.versionId ?? "");
    report("release smoke Evidence recorded", !!latest?.evidenceId, latest?.evidenceId ?? "");

    if (target) {
      const results = await runProbes(target.url, smokeProbes([]));
      for (const r of results)
        report(`release ${r.probe.name}`, r.ok, `GET ${r.probe.path} -> ${r.detail}`);
      const outcome = classifySmoke(results);
      report("release smoke outcome", outcome.status === "pass", outcome.summary);
    }
  }
} finally {
  await api.close();
}

console.log(failed === 0 ? "\nRelease smoke passed." : `\n${failed} release check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
