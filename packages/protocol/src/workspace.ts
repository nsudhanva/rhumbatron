import { z } from "zod";
import { Timestamp } from "./common.ts";

const Name = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const Commit = z.string().regex(/^[0-9a-f]{40}$/);

/** Public source and execution metadata. Credentials, URLs, headers and command output are excluded. */
export const WorkspaceManifest = z
  .object({
    manifestVersion: z.literal(1),
    projectId: Name,
    changeId: Name,
    taskId: Name,
    runId: Name,
    fork: Name,
    /** Hostname only: no userinfo, path, query, token or authorization header. */
    remoteHost: z
      .string()
      .max(253)
      .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i),
    baseCommit: Commit,
    startCommit: Commit,
    /** Dependency ChangeSet IDs, in the order used to prepare the stacked start. */
    stackedOn: z.array(Name).max(100),
    sandbox: z
      .object({
        id: Name,
        dir: z.string().regex(/^\/workspace\/[A-Za-z0-9_-]{1,128}$/),
        openedAt: Timestamp,
        closedAt: Timestamp.optional(),
        /** Seconds of inactivity before automatic sleep. */
        sleepAfter: z.number().int().positive(),
      })
      .strict(),
    toolsAllowed: z.array(Name).max(100),
    commandAllowlistVersion: z.number().int().positive(),
    /** Repository-relative paths from publish, relative to the canonical base. */
    files: z
      .array(
        z
          .string()
          .min(1)
          .max(1024)
          .refine(
            (path) =>
              !path.startsWith("/") &&
              !path.split("/").includes("..") &&
              !/[\r\n]|authorization\s*:|bearer\s+/i.test(path),
          ),
      )
      .max(2000),
    status: z.enum(["open", "published", "closed"]),
  })
  .strict()
  .refine((m) => (m.status === "closed") === (m.sandbox.closedAt !== undefined), {
    message: "Only a closed Workspace has closedAt",
  });
export type WorkspaceManifest = z.infer<typeof WorkspaceManifest>;

export const workspaceManifestPrefix = (
  m: Pick<WorkspaceManifest, "projectId" | "changeId" | "taskId">,
) => `workspace/${m.projectId}/${m.changeId}/${m.taskId}/`;

export const workspaceManifestKey = (
  m: Pick<WorkspaceManifest, "projectId" | "changeId" | "taskId" | "runId">,
) => `${workspaceManifestPrefix(m)}${m.runId}.json`;
