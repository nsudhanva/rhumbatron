// Fixture identity: the caller names itself in the x-user-id header.
export const FIXTURE_USERS = ["alice", "bob", "carol"] as const;

export type UserId = (typeof FIXTURE_USERS)[number];

export function resolveUser(header: string | undefined | null): UserId | null {
  return FIXTURE_USERS.find((u) => u === header) ?? null;
}
