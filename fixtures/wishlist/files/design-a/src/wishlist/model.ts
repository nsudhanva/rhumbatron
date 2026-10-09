// Design A: normalized, mutable relational tables.
//
// Wishlists, collaborator memberships, share links, and items are separate tables of rows. A
// membership row is updated in place when a collaborator is removed or a link is revoked, so the
// table always holds the current truth and nothing is denormalized. Effective access is derived on
// every request from the collaborator table: there is no cached membership to keep in sync.
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

export type WishlistRow = { id: string; ownerId: string; name: string; createdAt: number };
export type CollaboratorRow = {
  wishlistId: string;
  userId: string;
  role: Role;
  /** Share link token the member joined with; null for the owner. */
  viaLink: string | null;
  active: boolean;
  updatedAt: number;
};
export type ShareLinkRow = {
  token: string;
  wishlistId: string;
  active: boolean;
  updatedAt: number;
};
export type ItemRow = { wishlistId: string; productId: string; addedBy: string; addedAt: number };

export type WishlistState = {
  wishlists: WishlistRow[];
  collaborators: CollaboratorRow[];
  shareLinks: ShareLinkRow[];
  items: ItemRow[];
};

export function createWishlistState(): WishlistState {
  return { wishlists: [], collaborators: [], shareLinks: [], items: [] };
}

const findWishlist = (s: WishlistState, id: string) => s.wishlists.find((w) => w.id === id);

// SELECT role FROM collaborators WHERE wishlist_id = ? AND user_id = ? AND active
function roleOf(s: WishlistState, wishlistId: string, userId: string): Role | null {
  const row = s.collaborators.find(
    (r) => r.wishlistId === wishlistId && r.userId === userId && r.active,
  );
  return row ? row.role : null;
}

/** The wishlist plus the caller's current role, read from the membership table. */
function access(s: WishlistState, id: string, userId: string) {
  const wishlist = findWishlist(s, id);
  if (!wishlist) return err<{ wishlist: WishlistRow; role: Role }>("not_found");
  const role = roleOf(s, id, userId);
  return role ? ok({ wishlist, role }) : err<{ wishlist: WishlistRow; role: Role }>("forbidden");
}

export function createWishlist(s: WishlistState, ownerId: string, name: unknown): Result<string> {
  if (!validName(name)) return err("invalid_name");
  const now = Date.now();
  const id = `wl_${crypto.randomUUID()}`;
  s.wishlists.push({ id, ownerId, name: name.trim(), createdAt: now });
  s.collaborators.push({
    wishlistId: id,
    userId: ownerId,
    role: "owner",
    viaLink: null,
    active: true,
    updatedAt: now,
  });
  return ok(id);
}

export function viewWishlist(
  s: WishlistState,
  id: string,
  userId: string,
  lookup: Lookup,
): Result<WishlistView> {
  const found = access(s, id, userId);
  if (!found.ok) return found;
  const { wishlist } = found.value;
  // Items join products and the adder's current membership row.
  const items = s.items
    .filter((i) => i.wishlistId === id)
    .map((i) => {
      const product = lookup(i.productId);
      return {
        productId: i.productId,
        name: product?.name ?? "Unknown product",
        priceCents: product?.priceCents ?? 0,
        addedBy: i.addedBy,
        addedByRole: roleOf(s, id, i.addedBy),
      };
    });
  const collaborators = s.collaborators
    .filter((r) => r.wishlistId === id && r.active)
    .map((r) => ({ userId: r.userId, role: r.role }))
    .sort((a, b) =>
      a.role === b.role ? a.userId.localeCompare(b.userId) : a.role === "owner" ? -1 : 1,
    );
  return ok({
    id,
    name: wishlist.name,
    owner: wishlist.ownerId,
    collaborators,
    items,
    itemCount: items.length,
  });
}

export function shareWishlist(s: WishlistState, id: string, userId: string): Result<string> {
  const found = access(s, id, userId);
  if (!found.ok) return found;
  if (found.value.role !== "owner") return err("forbidden");
  const existing = s.shareLinks.find((l) => l.wishlistId === id && l.active);
  if (existing) return ok(existing.token);
  const token = crypto.randomUUID();
  s.shareLinks.push({ token, wishlistId: id, active: true, updatedAt: Date.now() });
  return ok(token);
}

/** Deactivates the link and, in place, every membership row that joined through it. */
export function revokeShareLink(s: WishlistState, id: string, userId: string): Result<null> {
  const found = access(s, id, userId);
  if (!found.ok) return found;
  if (found.value.role !== "owner") return err("forbidden");
  const now = Date.now();
  for (const link of s.shareLinks) {
    if (link.wishlistId !== id || !link.active) continue;
    link.active = false;
    link.updatedAt = now;
    for (const row of s.collaborators) {
      if (row.wishlistId === id && row.viaLink === link.token && row.active) {
        row.active = false;
        row.updatedAt = now;
      }
    }
  }
  return ok(null);
}

export function joinByLink(s: WishlistState, token: string, userId: string): Result<string> {
  const link = s.shareLinks.find((l) => l.token === token && l.active);
  if (!link) return err("invalid_link");
  const id = link.wishlistId;
  if (roleOf(s, id, userId)) return ok(id);
  const row = s.collaborators.find((r) => r.wishlistId === id && r.userId === userId);
  const now = Date.now();
  if (row) {
    // Rejoining reuses the membership row: UPDATE ... SET active = 1.
    row.active = true;
    row.role = "editor";
    row.viaLink = token;
    row.updatedAt = now;
  } else {
    s.collaborators.push({
      wishlistId: id,
      userId,
      role: "editor",
      viaLink: token,
      active: true,
      updatedAt: now,
    });
  }
  return ok(id);
}

export function addItem(
  s: WishlistState,
  id: string,
  userId: string,
  productId: string,
  lookup: Lookup,
): Result<null> {
  const found = access(s, id, userId);
  if (!found.ok) return found;
  if (!lookup(productId)) return err("unknown_product");
  if (s.items.some((i) => i.wishlistId === id && i.productId === productId)) return ok(null);
  s.items.push({ wishlistId: id, productId, addedBy: userId, addedAt: Date.now() });
  return ok(null);
}

export function removeItem(
  s: WishlistState,
  id: string,
  userId: string,
  productId: string,
): Result<null> {
  const found = access(s, id, userId);
  if (!found.ok) return found;
  const index = s.items.findIndex((i) => i.wishlistId === id && i.productId === productId);
  if (index === -1) return err("not_in_wishlist");
  s.items.splice(index, 1);
  return ok(null);
}

export function removeCollaborator(
  s: WishlistState,
  id: string,
  userId: string,
  targetId: string,
): Result<null> {
  const found = access(s, id, userId);
  if (!found.ok) return found;
  if (found.value.role !== "owner") return err("forbidden");
  const row = s.collaborators.find(
    (r) => r.wishlistId === id && r.userId === targetId && r.role === "editor" && r.active,
  );
  if (!row) return err("not_a_collaborator");
  row.active = false;
  row.updatedAt = Date.now();
  return ok(null);
}

/** Bulk load: inserts rows as given, without per-row checks. */
export function importWishlists(s: WishlistState, rows: readonly SeedWishlist[]): void {
  const now = Date.now();
  for (const w of rows) {
    s.wishlists.push({ id: w.id, ownerId: w.ownerId, name: w.name, createdAt: now });
    s.collaborators.push({
      wishlistId: w.id,
      userId: w.ownerId,
      role: "owner",
      viaLink: null,
      active: true,
      updatedAt: now,
    });
    if (w.shareToken) {
      s.shareLinks.push({ token: w.shareToken, wishlistId: w.id, active: true, updatedAt: now });
    }
    for (const userId of w.collaborators) {
      s.collaborators.push({
        wishlistId: w.id,
        userId,
        role: "editor",
        viaLink: w.shareToken,
        active: true,
        updatedAt: now,
      });
    }
    for (const item of w.items) {
      s.items.push({
        wishlistId: w.id,
        productId: item.productId,
        addedBy: item.addedBy,
        addedAt: now,
      });
    }
  }
}
