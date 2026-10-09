// Shared wishlist contract. Both data models implement the functions in ./model with these types,
// so the HTTP routes, tests, and benchmark are the same for every design.
import type { Product } from "../catalog";

export type Role = "owner" | "editor";

export type WishlistItemView = {
  productId: string;
  name: string;
  priceCents: number;
  addedBy: string;
  /** Current role of the user who added the item, or null when they are no longer a member. */
  addedByRole: Role | null;
};

export type WishlistView = {
  id: string;
  name: string;
  owner: string;
  collaborators: { userId: string; role: Role }[];
  items: WishlistItemView[];
  itemCount: number;
};

export type WishlistError =
  | "invalid_name"
  | "not_found"
  | "forbidden"
  | "unknown_product"
  | "not_in_wishlist"
  | "invalid_link"
  | "not_a_collaborator";

export type Result<T> = { ok: true; value: T } | { ok: false; error: WishlistError };

export type Lookup = (productId: string) => Product | undefined;

/** Bulk-load shape for fixtures and benchmarks: one wishlist with its members and items. */
export type SeedWishlist = {
  id: string;
  ownerId: string;
  name: string;
  /** Editors who joined through the wishlist's share link. */
  collaborators: string[];
  shareToken: string | null;
  items: { productId: string; addedBy: string }[];
};

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T>(error: WishlistError): Result<T> => ({ ok: false, error });

export function validName(name: unknown): name is string {
  return typeof name === "string" && name.trim().length > 0 && name.length <= 80;
}
