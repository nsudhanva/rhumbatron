import { WorkerEntrypoint } from "cloudflare:workers";
import { createWorker } from "@cloudflare/worker-bundler";
import { z } from "zod";
import {
  AppBundle,
  bundleObjectKey,
  decodeModules,
  encodeModules,
  type LoaderModule,
  MAX_MODULE_BYTES,
  modulesSize,
  readAppSettings,
} from "./bundle.ts";
import { type AppCheckResult, checkGap } from "./checker-result.ts";
import { runAppCheck, withCheckDeadline } from "./checker-runner.ts";
import { readCheckSource } from "./checker-source.ts";

const Input = z.object({
  projectId: z.string().regex(/^proj_[a-z0-9-]+$/),
  treeSha: z.string().regex(/^[0-9a-f]{40}$/),
  kind: z.enum(["build", "unit", "contract"]),
  timeoutMs: z.number().int().min(1).max(30_000).optional(),
});
export type AppCheckInput = z.infer<typeof Input>;
const LIMITS = { cpuMs: 50, subRequests: 1 } as const;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

/**
 * RPC only: bind APPS_CHECKER to entrypoint AppChecker. Source is read from the existing R2 code
 * store. Children receive no binding, no network, and no production app/data instance.
 */
export class AppChecker extends WorkerEntrypoint<Env> {
  async check(input: AppCheckInput): Promise<AppCheckResult> {
    const startedAt = new Date().toISOString();
    const parsed = Input.safeParse(input);
    if (!parsed.success)
      return {
        ...checkGap("build", "Invalid check input."),
        startedAt,
        completedAt: new Date().toISOString(),
      };
    const request = parsed.data;
    let active = true;
    let result: AppCheckResult;
    try {
      result = await withCheckDeadline(async () => {
        const { manifest, files } = await readCheckSource(
          this.env.EVIDENCE,
          request.projectId,
          request.treeSha,
        );
        const settings = readAppSettings(files);
        const ensureActive = () => {
          if (!active) throw new Error("Check timed out");
        };
        return runAppCheck(request.kind, files, {
          build: async () => {
            ensureActive();
            const built = await this.ctx.exports.AppBuilder({}).build({
              projectId: request.projectId,
              treeSha: request.treeSha,
              commit: manifest.commit,
              channel: "preview",
              files: Object.entries(files).map(([path, text]) => ({ path, text })),
            });
            ensureActive();
            if (!built.ok) throw new Error(built.reason);
            const object = await this.env.EVIDENCE.get(bundleObjectKey(built.bundleKey));
            if (!object) throw new Error("Built bundle is missing.");
            const bundle = AppBundle.parse(await object.json());
            if (
              bundle.treeSha !== request.treeSha ||
              bundle.commit !== manifest.commit ||
              bundle.projectId !== request.projectId
            )
              throw new Error("Built bundle source does not match the check.");
            return { mainModule: bundle.mainModule, modules: decodeModules(bundle.modules) };
          },
          bundle: async (options) => {
            ensureActive();
            const worker = await createWorker({ ...options, bundle: true, minify: false });
            ensureActive();
            const stored = encodeModules(worker.modules as Record<string, LoaderModule>);
            if (modulesSize(stored) > MAX_MODULE_BYTES)
              throw new Error("Check bundle exceeds 10 MB.");
            return { mainModule: worker.mainModule, modules: decodeModules(stored) };
          },
          execute: async (code) => {
            ensureActive();
            // load() creates a fresh isolate: tests and mutable module state cannot leak across runs.
            const worker = this.env.LOADER.load({
              ...code,
              compatibilityDate: settings.compatibilityDate ?? "2026-10-08",
              compatibilityFlags: [...new Set([...settings.compatibilityFlags, "nodejs_compat"])],
              globalOutbound: null,
              env: {},
              limits: LIMITS,
            });
            const response = await worker
              .getEntrypoint(undefined, { limits: LIMITS })
              .fetch(new Request("https://check.invalid/"));
            if (!response.ok || !response.body)
              throw new Error(`Check response ${response.status}`);
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                size += chunk.value.byteLength;
                if (size > MAX_REPORT_BYTES) throw new Error("Check report exceeds 2 MB.");
                chunks.push(chunk.value);
              }
            } finally {
              await reader.cancel();
            }
            ensureActive();
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
          },
        });
      }, request.timeoutMs ?? 30_000);
    } catch (error) {
      const reason = String(error);
      result = checkGap(request.kind, reason, /timed out|timeout/i.test(reason));
    } finally {
      active = false;
    }
    return { ...result, startedAt, completedAt: new Date().toISOString() };
  }
}
