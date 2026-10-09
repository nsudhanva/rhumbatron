// Design B: append-only membership event log with a materialized current-member set.
//
// Every membership change (created, joined, removed, link created, link revoked) is appended to
// `log` and never edited. `apply` folds each event into the materialized view in the same step, so
// reads use the current member set directly and never recompute access from history. The view can
// always be rebuilt from the log (`replay`); concurrent membership changes are ordered by `seq`.
import {
  err,
  type Lookup,
  ok,
  type Result,
  type Role,
  type SeedWishlist,
  validName,
  type WishlistView,
} from "./types";

export type MembershipEvent = Readonly<
  | { seq: number; type: "created"; wishlistId: string; userId: string; name: string }
  | { seq: number; type: "joined"; wishlistId: string; userId: string; via: string }
  | { seq: number; type: "removed"; wishlistId: string; userId: string }
  | { seq: number; type: "link_created"; wishlistId: string; token: string }
  | { seq: number; type: "link_revoked"; wishlistId: string; token: string }
>;

type Member = { role: Role; via: string | null };

/** Current state derived from the log. Rebuildable at any time with `replay`. */
export type MembershipView = {
  wishlists: Map<string, { ownerId: string; name: string }>;
  members: Map<string, Map<string, Member>>;
  links: Map<string, { wishlistId: string; active: boolean }>;
  activeLink: Map<string, string>;
};

export type WishlistState = {
  /** Append-only membership log. */
  log: MembershipEvent[];
  view: MembershipView;
  /** Items are a per-wishlist key-value set, keyed by product ID in insertion order. */
  items: Map<string, Map<string, { addedBy: string }>>;
};

type WithoutSeq<E> = E extends unknown ? Omit<E, "seq"> : never;
type NewEvent = WithoutSeq<MembershipEvent>;

const emptyView = (): MembershipView => ({
  wishlists: new Map(),
  members: new Map(),
  links: new Map(),
  activeLink: new Map(),
});

export function createWishlistState(): WishlistState {
  return { log: [], view: emptyView(), items: new Map() };
}

/** Folds one event into the materialized view. Deterministic: replaying the log gives the same view. */
export function apply(view: MembershipView, e: MembershipEvent): void {
  switch (e.type) {
    case "created":
      view.wishlists.set(e.wishlistId, { ownerId: e.userId, name: e.name });
      view.members.set(e.wishlistId, new Map([[e.userId, { role: "owner", via: null }]]));
      return;
    case "joined":
      view.members.get(e.wishlistId)?.set(e.userId, { role: "editor", via: e.via });
      return;
    case "removed":
      view.members.get(e.wishlistId)?.delete(e.userId);
      return;
    case "link_created":
      view.links.set(e.token, { wishlistId: e.wishlistId, active: true });
      view.activeLink.set(e.wishlistId, e.token);
      return;
    case "link_revoked": {
      const link = view.links.get(e.token);
      if (link) link.active = false;
      if (view.activeLink.get(e.wishlistId) === e.token) view.activeLink.delete(e.wishlistId);
      // Members who joined through the revoked link lose access.
      const members = view.members.get(e.wishlistId);
      for (const [userId, member] of members ?? []) {
        if (member.via === e.token) members?.delete(userId);
      }
      return;
    }
  }
}

/** Rebuilds the materialized view from the log alone. */
export function replay(log: readonly MembershipEvent[]): MembershipView {
  const view = emptyView();
  for (const e of log) apply(view, e);
  return view;
}

function append(s: WishlistState, event: NewEvent): void {
  const e = Object.freeze({ ...event, seq: s.log.length + 1 }) as MembershipEvent;
  s.log.push(e);
  apply(s.view, e);
}

const roleOf = (s: WishlistState, id: string, userId: string): Role | null =>
  s.view.members.get(id)?.get(userId)?.role ?? null;

function access(s: WishlistState, id: string, userId: string): Result<Role> {
  if (!s.view.wishlists.has(id)) return err("not_found");
  const role = roleOf(s, id, userId);
  return role ? ok(role) : err("forbidden");
}

export function createWishlist(s: WishlistState, ownerId: string, name: unknown): Result<string> {
  if (!validName(name)) return err("invalid_name");
  const id = `wl_${crypto.randomUUID()}`;
  append(s, { type: "created", wishlistId: id, userId: ownerId, name: name.trim() });
  s.items.set(id, new Map());
  return ok(id);
}

export function viewWishlist(
  s: WishlistState,
  id: string,
  userId: string,
  lookup: Lookup,
): Result<WishlistView> {
  const role = access(s, id, userId);
  if (!role.ok) return role;
  const wishlist = s.view.wishlists.get(id);
  const members = s.view.members.get(id) ?? new Map<string, Member>();
  const items = [...(s.items.get(id) ?? [])].map(([productId, item]) => {
    const product = lookup(productId);
    return {
      productId,
      name: product?.name ?? "Unknown product",
      priceCents: product?.priceCents ?? 0,
      addedBy: item.addedBy,
      addedByRole: members.get(item.addedBy)?.role ?? null,
    };
  });
  const collaborators = [...members]
    .map(([memberId, m]) => ({ userId: memberId, role: m.role }))
    .sort((a, b) =>
      a.role === b.role ? a.userId.localeCompare(b.userId) : a.role === "owner" ? -1 : 1,
    );
  return ok({
    id,
    name: wishlist?.name ?? "",
    owner: wishlist?.ownerId ?? "",
    collaborators,
    items,
    itemCount: items.length,
  });
}

export function shareWishlist(s: WishlistState, id: string, userId: string): Result<string> {
  const role = access(s, id, userId);
  if (!role.ok) return role;
  if (role.value !== "owner") return err("forbidden");
  const existing = s.view.activeLink.get(id);
  if (existing) return ok(existing);
  const token = crypto.randomUUID();
  append(s, { type: "link_created", wishlistId: id, token });
  return ok(token);
}

export function revokeShareLink(s: WishlistState, id: string, userId: string): Result<null> {
  const role = access(s, id, userId);
  if (!role.ok) return role;
  if (role.value !== "owner") return err("forbidden");
  const token = s.view.activeLink.get(id);
  if (token) append(s, { type: "link_revoked", wishlistId: id, token });
  return ok(null);
}

export function joinByLink(s: WishlistState, token: string, userId: string): Result<string> {
  const link = s.view.links.get(token);
  if (!link?.active) return err("invalid_link");
  if (!roleOf(s, link.wishlistId, userId)) {
    append(s, { type: "joined", wishlistId: link.wishlistId, userId, via: token });
  }
  return ok(link.wishlistId);
}

export function addItem(
  s: WishlistState,
  id: string,
  userId: string,
  productId: string,
  lookup: Lookup,
): Result<null> {
  const role = access(s, id, userId);
  if (!role.ok) return role;
  if (!lookup(productId)) return err("unknown_product");
  const items = s.items.get(id) ?? new Map<string, { addedBy: string }>();
  if (!items.has(productId)) items.set(productId, { addedBy: userId });
  s.items.set(id, items);
  return ok(null);
}

export function removeItem(
  s: WishlistState,
  id: string,
  userId: string,
  productId: string,
): Result<null> {
  const role = access(s, id, userId);
  if (!role.ok) return role;
  if (!s.items.get(id)?.delete(productId)) return err("not_in_wishlist");
  return ok(null);
}

export function removeCollaborator(
  s: WishlistState,
  id: string,
  userId: string,
  targetId: string,
): Result<null> {
  const role = access(s, id, userId);
  if (!role.ok) return role;
  if (role.value !== "owner") return err("forbidden");
  if (roleOf(s, id, targetId) !== "editor") return err("not_a_collaborator");
  append(s, { type: "removed", wishlistId: id, userId: targetId });
  return ok(null);
}

/** Bulk load: appends the events each wishlist's history implies, without per-row checks. */
export function importWishlists(s: WishlistState, rows: readonly SeedWishlist[]): void {
  for (const w of rows) {
    append(s, { type: "created", wishlistId: w.id, userId: w.ownerId, name: w.name });
    if (w.shareToken) append(s, { type: "link_created", wishlistId: w.id, token: w.shareToken });
    for (const userId of w.collaborators) {
      append(s, { type: "joined", wishlistId: w.id, userId, via: w.shareToken ?? "import" });
    }
    s.items.set(w.id, new Map(w.items.map((i) => [i.productId, { addedBy: i.addedBy }])));
  }
}
