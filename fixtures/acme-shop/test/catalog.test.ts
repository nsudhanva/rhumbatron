import { expect, test } from "bun:test";
import { createApp } from "../src/app";
import { createStore } from "../src/store";

const app = createApp(createStore());
const headers = { "x-user-id": "alice" };

test("lists seeded products with integer cent prices", async () => {
  const res = await app.request("/api/products", { headers });
  const { products } = (await res.json()) as { products: { priceCents: number }[] };
  expect(res.status).toBe(200);
  expect(products.length).toBeGreaterThanOrEqual(6);
  expect(products.every((p) => Number.isInteger(p.priceCents))).toBe(true);
});

test("product detail and unknown product", async () => {
  const ok = await app.request("/api/products/p-100", { headers });
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { name: string }).name).toBe("Trail Backpack");
  expect((await app.request("/api/products/nope", { headers })).status).toBe(404);
});

test("missing or unknown user is rejected", async () => {
  expect((await app.request("/api/products")).status).toBe(401);
  expect((await app.request("/api/products", { headers: { "x-user-id": "mallory" } })).status).toBe(
    401,
  );
});
