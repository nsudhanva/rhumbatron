import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { type EventEnvelope, FINAL_RELEASE_STATUSES } from "@rhumbatron/protocol";
import { ensureProductionBundle, movePointer, upsertVersionRow } from "./app-release.ts";
import { restorableTarget } from "./app-release-model.ts";
import { appendChangeEvents } from "./events.ts";
import {
  buildsConfigured,
  cloudflareGet,
  type LoadedRelease,
  loadRelease,
  type ReleaseParams,
  releaseEvent,
  smokeRelease,
  transitionRelease,
} from "./release.ts";
import {
  activeVersionId,
  type BuildRecord,
  buildPhase,
  matchBuild,
  maxPolls,
  POLL_DEADLINE_MS,
  pollDelaySeconds,
  supersededBy,
  versionFromBuild,
} from "./release-model.ts";

/**
 * ReleaseWorkflow (AGENTS.md sections 21.3, 37, 42.10; ADR 0018). One instance per Project and
 * promoted generation (instance ID = release ID, section 60). Promotion pushed canonical `main`;
 * Workers Builds builds and deploys that push. This workflow only observes and verifies:
 *
 *   1. Confirm the generation is still canonical (else superseded); `build.started`.
 *   2. Poll the Builds API with bounded backoff (15 minutes) for the build of the promoted commit.
 *   3. Record the build result: `build.completed`; a failed build is `deployment.failed`.
 *   4. Confirm the Worker's active version came from that build: `deployment.completed`.
 *   5. Smoke check the release URL; store release Evidence (R2 + D1).
 *   6. Pass: `deployed`. Fail: `smoke_failed` and `release.smoke_failed`.
 *
 * It never triggers a build, deploys, or deletes anything. Recovery from a failed release is a new
 * canonical transition (section 42.10). No model call decides anything here (section 22.7).
 * Steps: about 6 plus 2 per poll; a typical 2-minute build is about 16 steps of 3,000 per day.
 *
 * A Project with a live app (prod, ADR 0020) takes the app path instead (`runApp`): the bundle of
 * the promoted commit (stored, same tree, copied from its preview, or built), the production
 * pointer moved by compare-and-swap, and the same smoke probes through the apps router. A smoke
 * failure moves the pointer back to the version it replaced, as a new recorded transition, and the
 * release is `smoke_failed`. About 8 steps per release; no Workers Builds, no Sandbox.
 */

type Poll =
  | { kind: "superseded"; reason: string }
  | { kind: "pending"; buildUuid: string | null; status: string | null }
  | { kind: "not_connected" }
  | { kind: "stopped"; buildUuid: string; succeeded: boolean; reason: string | null };

export class ReleaseWorkflow extends WorkflowEntrypoint<Env, ReleaseParams> {
  override async run(event: Readonly<WorkflowEvent<ReleaseParams>>, step: WorkflowStep) {
    const { releaseId } = event.payload;
    const load = () => loadRelease(this.env, releaseId);

    const first = await step.do("load release", async () => {
      const loaded = await load();
      return loaded ? { status: loaded.release.status } : null;
    });
    if (!first) return { skipped: "missing" };
    if (FINAL_RELEASE_STATUSES.includes(first.status)) return { skipped: first.status };

    const required = async (): Promise<LoadedRelease> => {
      const loaded = await load();
      if (!loaded) throw new Error(`Release ${releaseId} disappeared`);
      return loaded;
    };
    const fail = (name: string, reason: string, buildUuid: string | null = null) =>
      step.do(name, async () => {
        const loaded = await required();
        return transitionRelease(
          this.env,
          loaded,
          "failed",
          { failureReason: reason.slice(0, 500), buildUuid },
          [
            await releaseEvent(loaded, "deployment.failed", {
              status: "failed",
              reason: reason.slice(0, 300),
              ...(buildUuid ? { buildUuid } : {}),
            }),
          ],
        );
      });
    const supersede = (name: string, reason: string) =>
      step.do(name, async () =>
        transitionRelease(this.env, await required(), "superseded", {
          failureReason: reason,
        }),
      );

    // Live apps replace Workers Builds for Projects that have an app (P16-11, P16-15).
    const path = await step.do("release path", async () =>
      (await required()).app ? "app" : "builds",
    );
    if (path === "app") return this.runApp(releaseId, step, { required, fail, supersede });

    // Step 1: the promoted generation is still canonical (section 21.3 step 1).
    const confirmed = await step.do(
      "confirm generation",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
      async () => {
        const loaded = await required();
        const canonical = await this.canonicalGeneration(loaded.release.project_id);
        if (supersededBy(loaded.release.generation, canonical)) {
          return { ok: false as const, why: "superseded", canonical };
        }
        if (canonical !== loaded.release.generation) {
          return { ok: false as const, why: "not_canonical", canonical };
        }
        if (!loaded.target) return { ok: false as const, why: "no_target", canonical };
        if (!buildsConfigured(this.env)) return { ok: false as const, why: "no_token", canonical };
        const status = await transitionRelease(this.env, loaded, "building", {}, [
          await releaseEvent(loaded, "build.started", {
            status: "building",
            workerName: loaded.target.worker_name,
            url: loaded.target.url,
          }),
        ]);
        return { ok: status === "building", why: status, canonical };
      },
    );
    if (!confirmed.ok) {
      if (confirmed.why === "superseded") {
        await supersede("mark superseded", `Canonical advanced to S${confirmed.canonical} first.`);
        return { status: "superseded" };
      }
      // Already final (for example superseded by a newer promotion): nothing to record.
      if (FINAL_RELEASE_STATUSES.includes(confirmed.why as never)) {
        return { status: confirmed.why };
      }
      const reasons: Record<string, string> = {
        not_canonical: `Canonical is S${confirmed.canonical}, not this release's generation.`,
        no_target: "The Project has no release target.",
        no_token: "BUILDS_API_TOKEN or BUILDS_ACCOUNT_ID is not bound on the integration Worker.",
      };
      await fail("mark failed", reasons[confirmed.why] ?? `Release is ${confirmed.why}.`);
      return { status: "failed", reason: confirmed.why };
    }

    // Step 2: poll for the build of the promoted commit, bounded (section 21.3 steps 2-3).
    const polls = maxPolls();
    let result: Poll = { kind: "pending", buildUuid: null, status: null };
    try {
      for (let i = 0; i < polls; i++) {
        result = await step.do(
          `poll build ${i}`,
          { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
          () => this.poll(releaseId, i),
        );
        if (result.kind !== "pending") break;
        if (i < polls - 1) await step.sleep(`wait ${i}`, `${pollDelaySeconds(i)} seconds`);
      }
    } catch (error) {
      // The Builds API kept failing (for example a token without the needed scope): a release
      // with no observed build is failed, never left building.
      await fail("mark poll error", `Builds API unavailable: ${String(error).slice(0, 300)}`);
      return { status: "failed", reason: "builds_api" };
    }

    if (result.kind === "superseded") {
      await supersede("mark superseded", result.reason);
      return { status: "superseded" };
    }
    if (result.kind === "not_connected") {
      await fail(
        "mark not connected",
        "Workers Builds has no trigger for the release Worker. Connect it once (ADR 0014, ADR 0018).",
      );
      return { status: "failed", reason: "not_connected" };
    }
    if (result.kind === "pending") {
      const minutes = Math.round(POLL_DEADLINE_MS / 60_000);
      await fail(
        "mark build timeout",
        result.buildUuid
          ? `Build ${result.buildUuid} did not finish within ${minutes} minutes (last status ${result.status ?? "unknown"}).`
          : `No build of the promoted commit appeared within ${minutes} minutes.`,
        result.buildUuid,
      );
      return { status: "failed", reason: "build_timeout" };
    }
    const build = result;

    // Step 3: record the build result.
    await step.do("record build", async () => {
      const loaded = await required();
      await this.append(loaded, [
        await releaseEvent(loaded, "build.completed", {
          status: build.succeeded ? "success" : "fail",
          buildUuid: build.buildUuid,
          ...(build.reason ? { reason: build.reason } : {}),
        }),
      ]);
      return build.buildUuid;
    });
    if (!build.succeeded) {
      await fail("mark build failed", build.reason ?? "The build failed.", build.buildUuid);
      return { status: "failed", reason: "build_failed" };
    }

    // Step 4: the deployed version came from this build (section 21.3 step 4).
    let deployment: { kind: "superseded" } | { kind: "confirmed"; versionId: string };
    try {
      deployment = await step.do(
        "confirm deployment",
        { retries: { limit: 4, delay: "15 seconds", backoff: "exponential" } },
        async () => {
          const loaded = await required();
          if (loaded.release.status === "superseded") return { kind: "superseded" as const };
          if (
            supersededBy(
              loaded.release.generation,
              await this.canonicalGeneration(loaded.release.project_id),
            )
          ) {
            return { kind: "superseded" as const };
          }
          const worker = loaded.target?.worker_name ?? "";
          const versionId = activeVersionId(
            await cloudflareGet(this.env, `/workers/scripts/${worker}/deployments`),
          );
          if (!versionId) throw new Error("The release Worker has no active deployment");
          const builds = await cloudflareGet(
            this.env,
            `/builds/builds?version_ids=${encodeURIComponent(versionId)}`,
          );
          // Thrown errors retry: the deployment can lag the build's stop by a few seconds.
          if (!versionFromBuild(builds, build.buildUuid)) {
            throw new Error(`Active version ${versionId} is not from build ${build.buildUuid}`);
          }
          await this.env.DB.prepare(
            "UPDATE releases SET version_id = ?, build_uuid = ? WHERE id = ? AND status = 'building'",
          )
            .bind(versionId, build.buildUuid, releaseId)
            .run();
          await this.append(loaded, [
            await releaseEvent(loaded, "deployment.completed", {
              status: "deployed",
              buildUuid: build.buildUuid,
              versionId,
              url: loaded.target?.url ?? "",
            }),
          ]);
          return { kind: "confirmed" as const, versionId };
        },
      );
    } catch (error) {
      await fail(
        "mark deployment unconfirmed",
        `Build ${build.buildUuid} succeeded, but its deployment was not confirmed: ${String(error).slice(0, 200)}`,
        build.buildUuid,
      );
      return { status: "failed", reason: "deployment_unconfirmed" };
    }
    if (deployment.kind === "superseded") {
      await supersede("mark superseded", "A newer generation was promoted during the build.");
      return { status: "superseded" };
    }

    // Steps 5-6: smoke check with Evidence. A fresh deployment can take seconds to serve, so one
    // failed attempt is retried once after a pause; the second attempt's Evidence decides.
    await step.sleep("settle", "10 seconds");
    let smoke = await step.do("smoke check 1", { retries: { limit: 1, delay: "10 seconds" } }, () =>
      this.smoke(releaseId, 1),
    );
    if (!smoke.passed) {
      await step.sleep("smoke pause", "20 seconds");
      smoke = await step.do("smoke check 2", { retries: { limit: 1, delay: "10 seconds" } }, () =>
        this.smoke(releaseId, 2),
      );
    }

    return step.do("finish release", async () => {
      const loaded = await required();
      if (smoke.passed) {
        const status = await transitionRelease(this.env, loaded, "deployed", {
          evidenceId: smoke.evidenceId,
          evidenceR2Key: smoke.r2Key,
        });
        return { status, versionId: deployment.versionId };
      }
      const status = await transitionRelease(
        this.env,
        loaded,
        "smoke_failed",
        { failureReason: smoke.summary, evidenceId: smoke.evidenceId, evidenceR2Key: smoke.r2Key },
        [
          await releaseEvent(loaded, "release.smoke_failed", {
            status: "smoke_failed",
            reason: smoke.summary.slice(0, 300),
            evidenceId: smoke.evidenceId,
            versionId: deployment.versionId,
            injected: false,
          }),
        ],
      );
      return { status, versionId: deployment.versionId };
    });
  }

  /** The live app path (P16-11, P16-12). Section 21.3 steps 1 to 6 on the app pointer. */
  private async runApp(
    releaseId: string,
    step: WorkflowStep,
    helpers: {
      required: () => Promise<LoadedRelease>;
      fail: (name: string, reason: string) => Promise<unknown>;
      supersede: (name: string, reason: string) => Promise<unknown>;
    },
  ) {
    const { required, fail, supersede } = helpers;
    // Step 1: the promoted generation is still canonical.
    const confirmed = await step.do(
      "confirm generation (app)",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
      async () => {
        const loaded = await required();
        const canonical = await this.canonicalGeneration(loaded.release.project_id);
        if (supersededBy(loaded.release.generation, canonical)) {
          return { ok: false as const, why: "superseded", canonical };
        }
        if (canonical !== loaded.release.generation) {
          return { ok: false as const, why: "not_canonical", canonical };
        }
        if (!loaded.app) return { ok: false as const, why: "no_app", canonical };
        const status = await transitionRelease(this.env, loaded, "building", {}, [
          await releaseEvent(loaded, "build.started", {
            status: "building",
            app: loaded.app.label,
          }),
        ]);
        return { ok: status === "building", why: status, canonical };
      },
    );
    if (!confirmed.ok) {
      if (confirmed.why === "superseded") {
        await supersede("mark superseded", `Canonical advanced to S${confirmed.canonical} first.`);
        return { status: "superseded" };
      }
      if (FINAL_RELEASE_STATUSES.includes(confirmed.why as never)) {
        return { status: confirmed.why };
      }
      const reason =
        confirmed.why === "no_app"
          ? "The Project's app was removed before its release."
          : `Canonical is S${confirmed.canonical}, not this release's generation.`;
      await fail("mark failed", reason);
      return { status: "failed", reason: confirmed.why };
    }

    // Step 2: the production bundle of the promoted commit (section 21.3 steps 2-3).
    const bundle = await step.do(
      "app bundle",
      { retries: { limit: 2, delay: "20 seconds", backoff: "exponential" }, timeout: "5 minutes" },
      async () => {
        const loaded = await required();
        const candidate = await this.env.DB.prepare(
          "SELECT composed_tree, rollback_of_generation FROM candidates WHERE id = ?",
        )
          .bind(loaded.release.candidate_id)
          .first<{ composed_tree: string | null; rollback_of_generation: number | null }>();
        if (!candidate?.composed_tree) {
          return { ok: false as const, reason: "The promoted Candidate has no recorded tree." };
        }
        const result = await ensureProductionBundle(this.env, {
          projectId: loaded.release.project_id,
          commit: loaded.release.commit_sha,
          treeSha: candidate.composed_tree,
          rollbackOfGeneration: candidate.rollback_of_generation,
        });
        await this.append(loaded, [
          await releaseEvent(loaded, "build.completed", {
            status: result.ok ? "success" : "fail",
            ...(result.ok
              ? { bundleKey: result.bundleKey, source: result.source }
              : { reason: result.reason.slice(0, 300) }),
          }),
        ]);
        return result;
      },
    );
    if (!bundle.ok) {
      await fail("mark build failed", bundle.reason);
      return { status: "failed", reason: "build_failed" };
    }

    // Step 3: move the production pointer (section 21.3 step 4). The previous version is kept in
    // this step's result, so a smoke failure can restore it.
    const moved = await step.do(
      "move pointer",
      { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
      async () => {
        const loaded = await required();
        if (
          loaded.release.status === "superseded" ||
          supersededBy(
            loaded.release.generation,
            await this.canonicalGeneration(loaded.release.project_id),
          )
        ) {
          return { kind: "superseded" as const };
        }
        const to = {
          commit: loaded.release.commit_sha,
          bundleKey: bundle.bundleKey,
          generation: loaded.release.generation,
        };
        const outcome = await movePointer(
          this.env,
          loaded.release.project_id,
          { kind: "release", to },
          bundle.bytes,
        );
        if (outcome.decision.kind === "refuse") {
          return { kind: "refused" as const, reason: outcome.decision.reason };
        }
        if (outcome.label) {
          await upsertVersionRow(this.env, {
            projectId: loaded.release.project_id,
            label: outcome.label,
            target: to,
            bytes: bundle.bytes,
          });
        }
        await this.env.DB.prepare(
          "UPDATE releases SET version_id = ? WHERE id = ? AND status = 'building'",
        )
          .bind(bundle.bundleKey, releaseId)
          .run();
        await this.append(loaded, [
          await releaseEvent(loaded, "deployment.completed", {
            status: "deployed",
            app: outcome.label,
            bundleKey: bundle.bundleKey,
            previousGeneration: outcome.previous?.generation ?? null,
          }),
        ]);
        return { kind: "moved" as const, previous: outcome.previous };
      },
    );
    if (moved.kind === "superseded" || (moved.kind === "refused" && moved.reason === "newer")) {
      await supersede("mark superseded", "A newer generation is already live.");
      return { status: "superseded" };
    }
    if (moved.kind === "refused") {
      await fail("mark pointer refused", `The production pointer did not move (${moved.reason}).`);
      return { status: "failed", reason: moved.reason };
    }

    // Steps 5-6: smoke check through the apps router, with Evidence. One retry after a pause.
    let smoke = await step.do("smoke check 1", { retries: { limit: 1, delay: "10 seconds" } }, () =>
      this.smoke(releaseId, 1),
    );
    if (!smoke.passed) {
      await step.sleep("smoke pause", "10 seconds");
      smoke = await step.do("smoke check 2", { retries: { limit: 1, delay: "10 seconds" } }, () =>
        this.smoke(releaseId, 2),
      );
    }
    if (smoke.passed) {
      return step.do("finish release", async () => {
        const status = await transitionRelease(this.env, await required(), "deployed", {
          evidenceId: smoke.evidenceId,
          evidenceR2Key: smoke.r2Key,
        });
        return { status };
      });
    }

    // P16-12: the old version goes live again, as a new recorded transition. Canonical keeps the
    // promoted generation (section 42.10); recovery is the next promotion or a rollback.
    const restored = await step.do(
      "restore previous version",
      { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
      async () => {
        const loaded = await required();
        const outcome = await movePointer(this.env, loaded.release.project_id, {
          kind: "revert",
          failed: { commit: loaded.release.commit_sha, generation: loaded.release.generation },
          to: restorableTarget(moved.previous),
        });
        if (outcome.decision.kind !== "move")
          return { restored: null, why: outcome.decision.reason };
        await this.append(loaded, [
          await releaseEvent(
            loaded,
            "deployment.completed",
            {
              status: "restored",
              reason: "smoke_failed",
              app: outcome.label,
              bundleKey: outcome.decision.to.bundleKey,
              restoredGeneration: outcome.decision.to.generation,
              failedGeneration: loaded.release.generation,
            },
            ":restore",
          ),
        ]);
        return { restored: outcome.decision.to.generation, why: null };
      },
    );
    return step.do("finish release", async () => {
      const loaded = await required();
      const tail =
        restored.restored !== null
          ? ` Production serves S${restored.restored} again.`
          : ` Production was not restored (${restored.why}).`;
      const status = await transitionRelease(
        this.env,
        loaded,
        "smoke_failed",
        {
          failureReason: `${smoke.summary}${tail}`.slice(0, 500),
          evidenceId: smoke.evidenceId,
          evidenceR2Key: smoke.r2Key,
        },
        [
          await releaseEvent(loaded, "release.smoke_failed", {
            status: "smoke_failed",
            reason: smoke.summary.slice(0, 300),
            evidenceId: smoke.evidenceId,
            restoredGeneration: restored.restored,
            injected: false,
          }),
        ],
      );
      return { status, restoredGeneration: restored.restored };
    });
  }

  private async canonicalGeneration(projectId: string): Promise<number> {
    const ns = this.env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
    const snapshot = await ns.get(ns.idFromName(projectId)).getCanonical();
    if (!snapshot) throw new Error(`Project ${projectId} has no canonical state`);
    return snapshot.generation;
  }

  private append(loaded: LoadedRelease, events: EventEnvelope[]) {
    return appendChangeEvents(this.env.RESOURCE_SHARD, loaded.ctx, events);
  }

  /** One poll: supersession first, then the build of the promoted commit. */
  private async poll(releaseId: string, attempt: number): Promise<Poll> {
    const loaded = await loadRelease(this.env, releaseId);
    if (!loaded) throw new Error(`Release ${releaseId} disappeared`);
    const { release, target } = loaded;
    if (release.status === "superseded") {
      return { kind: "superseded", reason: release.failure_reason ?? "Superseded." };
    }
    const canonical = await this.canonicalGeneration(release.project_id);
    if (supersededBy(release.generation, canonical)) {
      return {
        kind: "superseded",
        reason: `Canonical advanced to S${canonical} during the build.`,
      };
    }
    const tag = target?.worker_tag ?? "";
    const list = (await cloudflareGet(this.env, `/builds/workers/${tag}/builds?per_page=20`)) as {
      result?: BuildRecord[];
    };
    const build = matchBuild(list.result ?? [], release.commit_sha);
    if (!build) {
      // No build yet. On the first and third poll, check that a trigger exists at all.
      if (attempt === 0 || attempt === 2) {
        const triggers = (await cloudflareGet(this.env, `/builds/workers/${tag}/triggers`)) as {
          result?: unknown[];
        };
        if ((triggers.result ?? []).length === 0) return { kind: "not_connected" };
      }
      return { kind: "pending", buildUuid: null, status: null };
    }
    if (release.build_uuid !== build.build_uuid) {
      await this.env.DB.prepare(
        "UPDATE releases SET build_uuid = ? WHERE id = ? AND status = 'building'",
      )
        .bind(build.build_uuid, releaseId)
        .run();
    }
    const phase = buildPhase(build);
    if (phase.phase === "building") {
      return { kind: "pending", buildUuid: build.build_uuid, status: phase.status };
    }
    return {
      kind: "stopped",
      buildUuid: build.build_uuid,
      succeeded: phase.phase === "succeeded",
      reason: phase.phase === "failed" ? phase.reason : null,
    };
  }

  private async smoke(releaseId: string, attempt: number) {
    const loaded = await loadRelease(this.env, releaseId);
    if (!loaded) throw new Error(`Release ${releaseId} disappeared`);
    const { outcome, record, passed } = await smokeRelease(this.env, loaded, { attempt });
    return {
      passed,
      summary: outcome.summary,
      evidenceId: record.evidenceId,
      r2Key: record.r2Key ?? null,
    };
  }
}
