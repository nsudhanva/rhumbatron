import { z } from "zod";

/** Goal suggestions shown as pills under the new Change goal box. At most 5 short goals. */
export const MAX_GOAL_SUGGESTIONS = 5;

/** `GET /v1/projects/:projectId/suggestions` data. Empty when none are available (cap, failure). */
export const GoalSuggestions = z.object({
  suggestions: z.array(z.string().min(1).max(120)).max(MAX_GOAL_SUGGESTIONS),
  /** Canonical Generation the suggestions were ranked for; null when the Project has no state. */
  generation: z.number().int().nonnegative().nullable(),
});
export type GoalSuggestions = z.infer<typeof GoalSuggestions>;
