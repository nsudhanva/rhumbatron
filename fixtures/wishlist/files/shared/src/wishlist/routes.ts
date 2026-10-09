import type { Context, Hono } from "hono";
import type { UserId } from "../identity";
import type { Store } from "../store";
import {
  addItem,
  createWishlist,
  joinByLink,
  removeCollaborator,
  removeItem,
  revokeShareLink,
  shareWishlist,
  viewWishlist,
} from "./model";
import type { Result, WishlistError } from "./types";

type Env = { Variables: { user: UserId } };

const STATUS: Record<WishlistError, 400 | 403 | 404> = {
  invalid_name: 400,
  not_found: 404,
  forbidden: 403,
  unknown_product: 404,
  not_in_wishlist: 404,
  invalid_link: 404,
  not_a_collaborator: 404,
};

const body = async (c: Context<Env>): Promise<Record<string, unknown>> => {
  const parsed: unknown = await c.req.json().catch(() => null);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
};

/**
 * Shared wishlists: create, share by link, collaborators add and remove products, the owner
 * revokes the link or removes a collaborator. Every route needs the fixture user (x-user-id).
 */
export function registerWishlistRoutes(app: Hono<Env>, store: Store) {
  const state = store.wishlists;
  const lookup = (id: string) => store.products.get(id);

  // Returns the wishlist as `viewer` after a successful command, or the command's error.
  const reply = (c: Context<Env>, result: Result<unknown>, id: string, status: 200 | 201 = 200) => {
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error]);
    const view = viewWishlist(state, id, c.get("user"), lookup);
    if (!view.ok) return c.json({ error: view.error }, STATUS[view.error]);
    return c.json(view.value, status);
  };

  app.post("/api/wishlists", async (c) => {
    const created = createWishlist(state, c.get("user"), (await body(c)).name);
    return created.ok ? reply(c, created, created.value, 201) : reply(c, created, "");
  });

  app.get("/api/wishlists/:id", (c) => reply(c, { ok: true, value: null }, c.req.param("id")));

  app.post("/api/wishlists/:id/share", (c) => {
    const id = c.req.param("id");
    const shared = shareWishlist(state, id, c.get("user"));
    if (!shared.ok) return c.json({ error: shared.error }, STATUS[shared.error]);
    return c.json(
      { token: shared.value, joinPath: `/api/wishlist-links/${shared.value}/join` },
      201,
    );
  });

  app.delete("/api/wishlists/:id/share", (c) => {
    const id = c.req.param("id");
    return reply(c, revokeShareLink(state, id, c.get("user")), id);
  });

  app.post("/api/wishlist-links/:token/join", (c) => {
    const joined = joinByLink(state, c.req.param("token"), c.get("user"));
    return joined.ok ? reply(c, joined, joined.value) : reply(c, joined, "");
  });

  app.post("/api/wishlists/:id/items", async (c) => {
    const id = c.req.param("id");
    const productId = (await body(c)).productId;
    const added =
      typeof productId === "string"
        ? addItem(state, id, c.get("user"), productId, lookup)
        : ({ ok: false, error: "unknown_product" } as const);
    return reply(c, added, id, 201);
  });

  app.delete("/api/wishlists/:id/items/:productId", (c) => {
    const id = c.req.param("id");
    return reply(c, removeItem(state, id, c.get("user"), c.req.param("productId")), id);
  });

  app.delete("/api/wishlists/:id/collaborators/:userId", (c) => {
    const id = c.req.param("id");
    return reply(c, removeCollaborator(state, id, c.get("user"), c.req.param("userId")), id);
  });
}
