import { z } from "zod";
import { Id, Timestamp } from "./common.ts";

/** Commands request work and travel on Queues. `commandId` is stable across retries. */
export const commandEnvelope = <T extends z.ZodType>(payload: T) =>
  z.object({
    commandId: Id,
    commandType: z.string().regex(/^[a-z]+(\.[a-z]+)+$/),
    projectId: Id,
    /** Absent for project-level commands such as `project.provision`. */
    changeId: Id.optional(),
    taskId: Id.optional(),
    attempt: z.number().int().nonnegative(),
    createdAt: Timestamp,
    deadline: Timestamp.optional(),
    payload,
  });

export const AnyCommandEnvelope = commandEnvelope(z.unknown());
export type CommandEnvelope<T = unknown> = Omit<z.infer<typeof AnyCommandEnvelope>, "payload"> & {
  payload: T;
};
