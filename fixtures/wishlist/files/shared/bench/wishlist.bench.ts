/**
 * Wishlist API benchmark (AGENTS.md section 54: "Wishlist API p95 < 200 ms in the demo benchmark").
 * Loads one deterministic shop dataset, then replays the requests a busy shared wishlist sees:
 * 80% reads, 20% item adds and removes, all as a collaborator. Prints {"p95Ms": n, ...}.
 * The dataset and request mix are the same for every wishlist data model.
 */
import { createApp } from "../src/app";
import { createStore } from "../src/store";
import { importWishlists } from "../src/wishlist/model";
import type { SeedWishlist } from "../src/wishlist/types";

const WISHLISTS = 30_000;
const MAX_SAMPLES = 300;
/** Stop sampling after this much wall time, with at least MIN_SAMPLES samples. */
const BUDGET_MS = 15_000;
const MIN_SAMPLES = 12;
const PRODUCTS = 2_000;
const USERS = 50_000;
const HOT = "wl-hot";

// mulberry32: a fixed seed gives the same dataset on every run and for every design.
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = random(1841);
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const user = () => `u-${String(int(1, USERS)).padStart(5, "0")}`;
const product = (i: number) => `p-${1000 + i}`;

const store = createStore();
for (let i = 0; i < PRODUCTS; i++) {
  store.products.set(product(i), {
    id: product(i),
    name: `Catalog item ${i}`,
    priceCents: 500 + ((i * 37) % 20_000),
  });
}

function wishlist(
  id: string,
  ownerId: string,
  collaborators: string[],
  items: number,
): SeedWishlist {
  const members = [ownerId, ...collaborators];
  const start = int(0, PRODUCTS - items);
  return {
    id,
    ownerId,
    name: `List ${id}`,
    collaborators,
    shareToken: `link-${id}`,
    items: Array.from({ length: items }, (_, k) => ({
      productId: product(start + k),
      addedBy: members[k % members.length] ?? ownerId,
    })),
  };
}

const rows: SeedWishlist[] = [];
for (let i = 0; i < WISHLISTS; i++) {
  const collaborators = Array.from({ length: int(2, 20) }, user);
  rows.push(wishlist(`wl-${i}`, user(), collaborators, int(1, 15)));
}
// The shared wishlist under load: the newest list, shared with a large family, many products.
rows.push(wishlist(HOT, "alice", ["bob", "carol", ...Array.from({ length: 40 }, user)], 120));
importWishlists(store.wishlists, rows);
const dataset = {
  wishlists: rows.length,
  memberships: rows.reduce((n, w) => n + 1 + w.collaborators.length, 0),
  items: rows.reduce((n, w) => n + w.items.length, 0),
};
const app = createApp(store);

const headers = { "x-user-id": "bob", "content-type": "application/json" };
async function request(i: number) {
  const slot = i % 10;
  const productId = product(PRODUCTS - 1 - ((i / 10) | 0));
  const res =
    slot === 8
      ? await app.request(`/api/wishlists/${HOT}/items`, {
          method: "POST",
          headers,
          body: JSON.stringify({ productId }),
        })
      : slot === 9
        ? await app.request(`/api/wishlists/${HOT}/items/${productId}`, {
            method: "DELETE",
            headers,
          })
        : await app.request(`/api/wishlists/${HOT}`, { headers });
  if (res.status >= 300) throw new Error(`request ${i} returned ${res.status}`);
  await res.arrayBuffer();
}

const samples: number[] = [];
const began = performance.now();
for (let i = 0; i < MAX_SAMPLES; i++) {
  if (samples.length >= MIN_SAMPLES && performance.now() - began > BUDGET_MS) break;
  const start = performance.now();
  await request(i);
  samples.push(performance.now() - start);
}

samples.sort((a, b) => a - b);
const p95Ms = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] ?? 0;
process.stdout.write(
  `${JSON.stringify({
    p95Ms,
    samples: samples.length,
    dataset,
  })}\n`,
);
