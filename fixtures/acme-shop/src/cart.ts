import type { Product } from "./catalog";

const MAX_QUANTITY = 99;

export type CartItem = { productId: string; quantity: number };
export type Cart = readonly CartItem[];
export type CartTotals = { itemCount: number; subtotalCents: number };

export type CartError = "unknown_product" | "invalid_quantity" | "not_in_cart";
export type CartResult = { ok: true; cart: Cart } | { ok: false; error: CartError };

type Lookup = (productId: string) => Product | undefined;

function isValidQuantity(q: unknown): q is number {
  return typeof q === "number" && Number.isInteger(q) && q >= 1 && q <= MAX_QUANTITY;
}

// Adding an existing product increments its quantity, capped at MAX_QUANTITY.
export function addItem(
  cart: Cart,
  productId: string,
  quantity: number,
  lookup: Lookup,
): CartResult {
  if (!lookup(productId)) return { ok: false, error: "unknown_product" };
  if (!isValidQuantity(quantity)) return { ok: false, error: "invalid_quantity" };
  const existing = cart.find((i) => i.productId === productId);
  if (!existing) return { ok: true, cart: [...cart, { productId, quantity }] };
  const next = Math.min(existing.quantity + quantity, MAX_QUANTITY);
  return {
    ok: true,
    cart: cart.map((i) => (i.productId === productId ? { productId, quantity: next } : i)),
  };
}

export function setQuantity(cart: Cart, productId: string, quantity: number): CartResult {
  if (!isValidQuantity(quantity)) return { ok: false, error: "invalid_quantity" };
  if (!cart.some((i) => i.productId === productId)) return { ok: false, error: "not_in_cart" };
  return {
    ok: true,
    cart: cart.map((i) => (i.productId === productId ? { productId, quantity } : i)),
  };
}

export function removeItem(cart: Cart, productId: string): CartResult {
  if (!cart.some((i) => i.productId === productId)) return { ok: false, error: "not_in_cart" };
  return { ok: true, cart: cart.filter((i) => i.productId !== productId) };
}

export function totals(cart: Cart, lookup: Lookup): CartTotals {
  let itemCount = 0;
  let subtotalCents = 0;
  for (const item of cart) {
    itemCount += item.quantity;
    subtotalCents += (lookup(item.productId)?.priceCents ?? 0) * item.quantity;
  }
  return { itemCount, subtotalCents };
}
