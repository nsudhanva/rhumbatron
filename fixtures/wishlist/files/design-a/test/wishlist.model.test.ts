// Design A: membership rows are updated in place; access is read from the current rows.
import { expect, test } from "bun:test";
import { SEED_PRODUCTS } from "../src/catalog";
import {
  addItem,
  createWishlist,
  createWishlistState,
  joinByLink,
  revokeShareLink,
  shareWishlist,
  viewWishlist,
} from "../src/wishlist/model";

const lookup = (id: string) => SEED_PRODUCTS.find((p) => p.id === id);
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

test("revoking a link deactivates its membership rows in place", () => {
  const s = createWishlistState();
  const id = must(createWishlist(s, "alice", "Gifts"));
  const token = must(shareWishlist(s, id, "alice"));
  must(joinByLink(s, token, "bob"));
  expect(s.collaborators).toHaveLength(2);

  must(revokeShareLink(s, id, "alice"));
  expect(s.collaborators).toHaveLength(2);
  expect(s.collaborators.find((r) => r.userId === "bob")?.active).toBe(false);
  expect(s.shareLinks.every((l) => !l.active)).toBe(true);
  expect(addItem(s, id, "bob", "p-100", lookup)).toEqual({ ok: false, error: "forbidden" });
});

test("rejoining through a new link reactivates the same row", () => {
  const s = createWishlistState();
  const id = must(createWishlist(s, "alice", "Gifts"));
  must(joinByLink(s, must(shareWishlist(s, id, "alice")), "bob"));
  must(revokeShareLink(s, id, "alice"));
  must(joinByLink(s, must(shareWishlist(s, id, "alice")), "bob"));
  expect(s.collaborators.filter((r) => r.userId === "bob")).toHaveLength(1);
  expect(must(viewWishlist(s, id, "bob", lookup)).collaborators).toHaveLength(2);
});
