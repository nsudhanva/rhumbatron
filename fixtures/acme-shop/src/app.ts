import { Hono } from "hono";
import { addItem, type Cart, type CartError, removeItem, setQuantity, totals } from "./cart";
import { resolveUser, type UserId } from "./identity";
import { getCart, type Store, setCart } from "./store";

type Env = { Variables: { user: UserId } };

const ERROR_STATUS: Record<CartError, 400 | 404> = {
  unknown_product: 404,
  invalid_quantity: 400,
  not_in_cart: 404,
};

export function createApp(store: Store) {
  const app = new Hono<Env>();
  const lookup = (id: string) => store.products.get(id);

  app.use("/api/*", async (c, next) => {
    const user = resolveUser(c.req.header("x-user-id"), c.req.header("cookie"));
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("user", user);
    await next();
  });

  app.get("/api/products", (c) => c.json({ products: [...store.products.values()] }));

  app.get("/api/products/:id", (c) => {
    const product = lookup(c.req.param("id"));
    return product ? c.json(product) : c.json({ error: "unknown_product" }, 404);
  });

  const cartView = (cart: Cart) => ({ items: cart, ...totals(cart, lookup) });

  app.get("/api/cart", (c) => c.json(cartView(getCart(store, c.get("user")))));

  // Applies a cart operation and stores the result, or returns the error.
  const respond = (
    c: { get: (k: "user") => UserId; json: (b: unknown, s?: 400 | 404) => Response },
    result: ReturnType<typeof removeItem>,
  ) => {
    if (!result.ok) return c.json({ error: result.error }, ERROR_STATUS[result.error]);
    setCart(store, c.get("user"), result.cart);
    return c.json(cartView(result.cart));
  };

  app.post("/api/cart/items", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body !== "object" || body === null) return c.json({ error: "invalid_body" }, 400);
    const cart = getCart(store, c.get("user"));
    return respond(c, addItem(cart, body?.productId, body?.quantity, lookup));
  });

  app.patch("/api/cart/items/:productId", async (c) => {
    const body = await c.req.json().catch(() => null);
    const cart = getCart(store, c.get("user"));
    return respond(c, setQuantity(cart, c.req.param("productId"), body?.quantity));
  });

  app.delete("/api/cart/items/:productId", (c) =>
    respond(c, removeItem(getCart(store, c.get("user")), c.req.param("productId"))),
  );

  return app;
}
