import type { Cart } from "./cart";
import { type Product, SEED_PRODUCTS } from "./catalog";
import type { UserId } from "./identity";

// In-memory data. A later feature can add its own module and map next to carts.
export type Store = {
  products: Map<string, Product>;
  carts: Map<UserId, Cart>;
};

export function createStore(): Store {
  return {
    products: new Map(SEED_PRODUCTS.map((p) => [p.id, p])),
    carts: new Map(),
  };
}

export function getCart(store: Store, user: UserId): Cart {
  return store.carts.get(user) ?? [];
}

export function setCart(store: Store, user: UserId, cart: Cart): void {
  store.carts.set(user, cart);
}
