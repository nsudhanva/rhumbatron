import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { type EventEnvelope, FINAL_RELEASE_STATUSES } from "@rhumbatron/protocol";
import { ensureProductionBundle, movePointer, upsertVersionRow } from "./app-release.ts";
import { restorableTarget } from "./app-release-model.ts";
import { appendChangeEvents } from "./events.ts";
import {
  type LoadedRelease,
  loadRelease,
  type ReleaseParams,
  releaseEvent,
  smokeRelease,
  transitionRelease,
} from "./release.ts";
import { supersededBy } from "./release-model.ts";

/**
 * ReleaseWorkflow (ADR 0020). One instance per Project and
 * promoted generation (instance ID = release ID). The release of a Project with a
 * live app:
 *
 *   1. Confirm the generation is still canonical (else superseded); `build.started`.
 *   2. The bundle of the promoted commit (stored, same tree, copied from its preview, or built);
 *      `build.completed`.
 *   3. Move the production pointer by compare-and-swap; `deployment.completed`.
 *   4. Smoke probes through the apps router; store release Evidence (R2 + D1).
 *   5. Pass: `deployed`. Fail: the pointer moves back to the version it replaced, as a new
 *      recorded transition, and the release is `smoke_failed` (`release.smoke_failed`).
 *
 * Recovery from a failed release is a new canonical transition. No model call
 * decides anything here. About 8 steps per release; no Sandbox.
 */

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
    const fail = (name: string, reason: string) =>
      step.do(name, async () => {
        const loaded = await required();
        return transitionRelease(
          this.env,
          loaded,
          "failed",
          { failureReason: reason.slice(0, 500) },
          [
            await releaseEvent(loaded, "deployment.failed", {
              status: "failed",
              reason: reason.slice(0, 300),
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

    return this.runApp(releaseId, step, { required, fail, supersede });
  }

  /** ReleaseWorkflow steps 1 to 6 on the app pointer. */
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

    // Step 2: the production bundle of the promoted commit.
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

    // Step 3: move the production pointer. The previous version is kept in
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
    // promoted generation; recovery is the next promotion or a rollback.
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
