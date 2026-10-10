// Protected Cart invariant: existing cart add, remove, quantity, and total
// behavior must remain unchanged.
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { addItem, type Cart, removeItem, setQuantity, totals } from "../src/cart";
import { SEED_PRODUCTS } from "../src/catalog";
import { createStore } from "../src/store";

const lookup = (id: string) => SEED_PRODUCTS.find((p) => p.id === id);
const must = (r: { ok: boolean; cart?: Cart }) => {
  if (!r.ok || !r.cart) throw new Error("expected ok");
  return r.cart;
};

describe("cart logic", () => {
  test("add creates a line and increments an existing one", () => {
    const one = must(addItem([], "p-100", 2, lookup));
    expect(one).toEqual([{ productId: "p-100", quantity: 2 }]);
    expect(must(addItem(one, "p-100", 3, lookup))).toEqual([{ productId: "p-100", quantity: 5 }]);
  });

  test("add caps quantity at 99", () => {
    const cart = must(addItem([], "p-100", 98, lookup));
    expect(must(addItem(cart, "p-100", 5, lookup))).toEqual([{ productId: "p-100", quantity: 99 }]);
  });

  test("add rejects unknown product and bad quantities", () => {
    expect(addItem([], "nope", 1, lookup)).toEqual({ ok: false, error: "unknown_product" });
    for (const q of [0, -1, 100, 1.5, Number.NaN, "2" as unknown as number]) {
      expect(addItem([], "p-100", q, lookup)).toEqual({ ok: false, error: "invalid_quantity" });
    }
  });

  test("setQuantity replaces quantity and validates", () => {
    const cart = must(addItem([], "p-101", 2, lookup));
    expect(must(setQuantity(cart, "p-101", 7))).toEqual([{ productId: "p-101", quantity: 7 }]);
    expect(setQuantity(cart, "p-101", 0)).toEqual({ ok: false, error: "invalid_quantity" });
    expect(setQuantity(cart, "p-102", 1)).toEqual({ ok: false, error: "not_in_cart" });
  });

  test("remove drops a line and rejects missing lines", () => {
    const cart = must(addItem(must(addItem([], "p-100", 1, lookup)), "p-101", 1, lookup));
    expect(must(removeItem(cart, "p-100"))).toEqual([{ productId: "p-101", quantity: 1 }]);
    expect(removeItem(cart, "p-102")).toEqual({ ok: false, error: "not_in_cart" });
  });

  test("totals use integer cents", () => {
    expect(totals([], lookup)).toEqual({ itemCount: 0, subtotalCents: 0 });
    const cart: Cart = [
      { productId: "p-100", quantity: 2 }, // 8900 each
      { productId: "p-101", quantity: 3 }, // 2400 each
    ];
    expect(totals(cart, lookup)).toEqual({ itemCount: 5, subtotalCents: 2 * 8900 + 3 * 2400 });
  });
});

describe("cart routes", () => {
  const send = (
    app: ReturnType<typeof createApp>,
    user: string,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    app.request(path, {
      method,
      headers: { "x-user-id": user, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  test("rejects an unknown user; no identity is the demo user", async () => {
    const app = createApp(createStore());
    expect((await send(app, "mallory", "GET", "/api/cart")).status).toBe(401);
    expect((await app.request("/api/cart")).status).toBe(200);
  });

  test("add, update, remove, and totals over HTTP", async () => {
    const app = createApp(createStore());
    expect(await (await send(app, "alice", "GET", "/api/cart")).json()).toEqual({
      items: [],
      itemCount: 0,
      subtotalCents: 0,
    });

    await send(app, "alice", "POST", "/api/cart/items", { productId: "p-100", quantity: 2 });
    await send(app, "alice", "POST", "/api/cart/items", { productId: "p-100", quantity: 1 });
    const added = await send(app, "alice", "POST", "/api/cart/items", {
      productId: "p-106",
      quantity: 4,
    });
    expect(await added.json()).toEqual({
      items: [
        { productId: "p-100", quantity: 3 },
        { productId: "p-106", quantity: 4 },
      ],
      itemCount: 7,
      subtotalCents: 3 * 8900 + 4 * 900,
    });

    const patched = await send(app, "alice", "PATCH", "/api/cart/items/p-100", { quantity: 1 });
    expect(await patched.json()).toEqual({
      items: [
        { productId: "p-100", quantity: 1 },
        { productId: "p-106", quantity: 4 },
      ],
      itemCount: 5,
      subtotalCents: 8900 + 4 * 900,
    });

    const removed = await send(app, "alice", "DELETE", "/api/cart/items/p-100");
    expect(await removed.json()).toEqual({
      items: [{ productId: "p-106", quantity: 4 }],
      itemCount: 4,
      subtotalCents: 4 * 900,
    });
  });

  test("error statuses", async () => {
    const app = createApp(createStore());
    expect(
      (await send(app, "alice", "POST", "/api/cart/items", { productId: "nope", quantity: 1 }))
        .status,
    ).toBe(404);
    expect(
      (await send(app, "alice", "POST", "/api/cart/items", { productId: "p-100", quantity: 0 }))
        .status,
    ).toBe(400);
    expect((await send(app, "alice", "POST", "/api/cart/items", "garbage")).status).toBe(400);
    expect(
      (await send(app, "alice", "PATCH", "/api/cart/items/p-100", { quantity: 1 })).status,
    ).toBe(404);
    expect((await send(app, "alice", "DELETE", "/api/cart/items/p-100")).status).toBe(404);
  });

  test("carts are per user", async () => {
    const app = createApp(createStore());
    await send(app, "alice", "POST", "/api/cart/items", { productId: "p-100", quantity: 1 });
    const bob = (await (await send(app, "bob", "GET", "/api/cart")).json()) as { items: unknown[] };
    expect(bob.items).toEqual([]);
  });
});
