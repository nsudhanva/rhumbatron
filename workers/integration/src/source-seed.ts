/**
 * The one rule for seeding a Project's source: seed only a Project whose
 * canonical source is unassigned at Generation 0. A Project with source, a purged Project, or one
 * whose ProjectRootDO is missing is never seeded, so a repeat or a late command cannot overwrite a
 * real repository. ProjectRootDO.assignSource enforces the same rule again at the write.
 */

type CanonicalLike = { artifactRef: string; generation: number } | null;

export function needsSourceSeed(canonical: CanonicalLike): boolean {
  return !!canonical && canonical.artifactRef === "unassigned" && canonical.generation === 0;
}

export type SeedOutcome = "seeded" | "has_source" | "missing";

/** Calls `provision` only when the canonical source is unassigned. */
export async function seedSourceIfUnassigned(deps: {
  getCanonical(): Promise<CanonicalLike>;
  provision(): Promise<unknown>;
}): Promise<SeedOutcome> {
  const canonical = await deps.getCanonical();
  if (!canonical) return "missing";
  if (!needsSourceSeed(canonical)) return "has_source";
  await deps.provision();
  return "seeded";
}
