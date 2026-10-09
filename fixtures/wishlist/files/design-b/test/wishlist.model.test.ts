// Design B: the membership log is append-only and the materialized view equals its replay.
import { expect, test } from "bun:test";
import { SEED_PRODUCTS } from "../src/catalog";
import {
  addItem,
  createWishlist,
  createWishlistState,
  joinByLink,
  removeCollaborator,
  replay,
  revokeShareLink,
  shareWishlist,
} from "../src/wishlist/model";

const lookup = (id: string) => SEED_PRODUCTS.find((p) => p.id === id);
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

test("revoking a link appends an event and keeps earlier events", () => {
  const s = createWishlistState();
  const id = must(createWishlist(s, "alice", "Gifts"));
  must(joinByLink(s, must(shareWishlist(s, id, "alice")), "bob"));
  const before = s.log.map((e) => ({ ...e }));

  must(revokeShareLink(s, id, "alice"));
  expect(s.log.slice(0, before.length)).toEqual(before);
  expect(s.log.at(-1)?.type).toBe("link_revoked");
  expect(s.log.map((e) => e.seq)).toEqual(s.log.map((_, i) => i + 1));
  expect(Object.isFrozen(s.log[0])).toBe(true);
  expect(addItem(s, id, "bob", "p-100", lookup)).toEqual({ ok: false, error: "forbidden" });
});

test("the materialized members equal a replay of the log", () => {
  const s = createWishlistState();
  const id = must(createWishlist(s, "alice", "Gifts"));
  must(joinByLink(s, must(shareWishlist(s, id, "alice")), "bob"));
  must(revokeShareLink(s, id, "alice"));
  must(joinByLink(s, must(shareWishlist(s, id, "alice")), "carol"));
  must(joinByLink(s, must(shareWishlist(s, id, "alice")), "bob"));
  must(removeCollaborator(s, id, "alice", "carol"));
  expect(replay(s.log)).toEqual(s.view);
  expect([...(s.view.members.get(id)?.keys() ?? [])].sort()).toEqual(["alice", "bob"]);
});
