// Fake identity (no real login, ADR 0020). The caller names itself in the x-user-id header, or
// picks a demo user in the `acme_user` cookie. With neither, the caller is the demo user, so the
// shop works in a browser with no sign-in. An unknown name is rejected.
export const FIXTURE_USERS = ["alice", "bob", "carol"] as const;

export type UserId = (typeof FIXTURE_USERS)[number];

export const DEMO_USER: UserId = "alice";

const DEMO_COOKIE = /(?:^|;\s*)acme_user=([^;]*)/;

export function resolveUser(
  header: string | undefined | null,
  cookie?: string | undefined | null,
): UserId | null {
  const name = header || cookie?.match(DEMO_COOKIE)?.[1] || DEMO_USER;
  return FIXTURE_USERS.find((u) => u === name) ?? null;
}
