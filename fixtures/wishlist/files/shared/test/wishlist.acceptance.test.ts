// Shared wishlist acceptance tests. They use only the HTTP API, so they hold for every data model.
// Tests named "authorization ..." are the security check (bun test --test-name-pattern authorization).
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { createStore } from "../src/store";
import type { WishlistView } from "../src/wishlist/types";

type App = ReturnType<typeof createApp>;

const send = (app: App, user: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "x-user-id": user, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function setup() {
  const app = createApp(createStore());
  const created = await send(app, "alice", "POST", "/api/wishlists", { name: "Camping trip" });
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as WishlistView;
  return { app, id };
}

async function shareAndJoin(app: App, id: string, user: string) {
  const shared = await send(app, "alice", "POST", `/api/wishlists/${id}/share`);
  expect(shared.status).toBe(201);
  const { token, joinPath } = (await shared.json()) as { token: string; joinPath: string };
  expect(joinPath).toBe(`/api/wishlist-links/${token}/join`);
  expect((await send(app, user, "POST", joinPath)).status).toBe(200);
  return { token, joinPath };
}

const view = async (app: App, user: string, id: string) =>
  (await (await send(app, user, "GET", `/api/wishlists/${id}`)).json()) as WishlistView;

describe("wishlists", () => {
  test("owner creates a wishlist and adds products", async () => {
    const { app, id } = await setup();
    const added = await send(app, "alice", "POST", `/api/wishlists/${id}/items`, {
      productId: "p-103",
    });
    expect(added.status).toBe(201);
    expect(await added.json()).toEqual({
      id,
      name: "Camping trip",
      owner: "alice",
      collaborators: [{ userId: "alice", role: "owner" }],
      items: [
        {
          productId: "p-103",
          name: "Headlamp",
          priceCents: 3500,
          addedBy: "alice",
          addedByRole: "owner",
        },
      ],
      itemCount: 1,
    });
  });

  test("adding the same product twice keeps one line", async () => {
    const { app, id } = await setup();
    await send(app, "alice", "POST", `/api/wishlists/${id}/items`, { productId: "p-100" });
    await send(app, "alice", "POST", `/api/wishlists/${id}/items`, { productId: "p-100" });
    expect((await view(app, "alice", id)).itemCount).toBe(1);
  });

  test("validation errors", async () => {
    const { app, id } = await setup();
    expect((await send(app, "alice", "POST", "/api/wishlists", { name: " " })).status).toBe(400);
    expect((await send(app, "alice", "GET", "/api/wishlists/wl_missing")).status).toBe(404);
    const unknown = await send(app, "alice", "POST", `/api/wishlists/${id}/items`, {
      productId: "nope",
    });
    expect(unknown.status).toBe(404);
    expect((await send(app, "alice", "DELETE", `/api/wishlists/${id}/items/p-100`)).status).toBe(
      404,
    );
  });

  test("wishlist actions leave the cart unchanged", async () => {
    const { app, id } = await setup();
    await send(app, "alice", "POST", "/api/cart/items", { productId: "p-101", quantity: 2 });
    const before = await (await send(app, "alice", "GET", "/api/cart")).json();
    await send(app, "alice", "POST", `/api/wishlists/${id}/items`, { productId: "p-101" });
    await send(app, "alice", "DELETE", `/api/wishlists/${id}/items/p-101`);
    expect(await (await send(app, "alice", "GET", "/api/cart")).json()).toEqual(before);
  });
});

describe("wishlist sharing", () => {
  test("authorization: non-members cannot read or change a wishlist", async () => {
    const { app, id } = await setup();
    expect((await send(app, "bob", "GET", `/api/wishlists/${id}`)).status).toBe(403);
    const write = await send(app, "bob", "POST", `/api/wishlists/${id}/items`, {
      productId: "p-100",
    });
    expect(write.status).toBe(403);
    expect((await send(app, "mallory", "GET", `/api/wishlists/${id}`)).status).toBe(401);
  });

  test("authorization: a share link lets a collaborator add and remove products", async () => {
    const { app, id } = await setup();
    await send(app, "alice", "POST", `/api/wishlists/${id}/items`, { productId: "p-100" });
    await shareAndJoin(app, id, "bob");

    const added = await send(app, "bob", "POST", `/api/wishlists/${id}/items`, {
      productId: "p-104",
    });
    expect(added.status).toBe(201);
    const removed = await send(app, "bob", "DELETE", `/api/wishlists/${id}/items/p-100`);
    expect(removed.status).toBe(200);

    // The owner sees the collaborator's changes.
    const owner = await view(app, "alice", id);
    expect(owner.collaborators).toEqual([
      { userId: "alice", role: "owner" },
      { userId: "bob", role: "editor" },
    ]);
    expect(owner.items.map((i) => [i.productId, i.addedBy, i.addedByRole])).toEqual([
      ["p-104", "bob", "editor"],
    ]);
  });

  test("authorization: only the owner shares, revokes, or removes collaborators", async () => {
    const { app, id } = await setup();
    await shareAndJoin(app, id, "bob");
    expect((await send(app, "bob", "POST", `/api/wishlists/${id}/share`)).status).toBe(403);
    expect((await send(app, "bob", "DELETE", `/api/wishlists/${id}/share`)).status).toBe(403);
    const kick = await send(app, "bob", "DELETE", `/api/wishlists/${id}/collaborators/alice`);
    expect(kick.status).toBe(403);
  });

  test("authorization: revoking the link denies later collaborator writes", async () => {
    const { app, id } = await setup();
    const { joinPath } = await shareAndJoin(app, id, "bob");
    await send(app, "bob", "POST", `/api/wishlists/${id}/items`, { productId: "p-102" });

    const revoked = await send(app, "alice", "DELETE", `/api/wishlists/${id}/share`);
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as WishlistView).collaborators).toEqual([
      { userId: "alice", role: "owner" },
    ]);

    const write = await send(app, "bob", "POST", `/api/wishlists/${id}/items`, {
      productId: "p-105",
    });
    expect(write.status).toBe(403);
    expect((await send(app, "bob", "DELETE", `/api/wishlists/${id}/items/p-102`)).status).toBe(403);
    // The old link no longer admits anyone.
    expect((await send(app, "carol", "POST", joinPath)).status).toBe(404);
    expect((await send(app, "bob", "POST", joinPath)).status).toBe(404);
    // Items the removed collaborator added stay, attributed to a non-member.
    const owner = await view(app, "alice", id);
    expect(owner.items.map((i) => [i.productId, i.addedByRole])).toEqual([["p-102", null]]);
  });

  test("authorization: a new link works after a revoke, the old one stays dead", async () => {
    const { app, id } = await setup();
    const first = await shareAndJoin(app, id, "bob");
    await send(app, "alice", "DELETE", `/api/wishlists/${id}/share`);
    const second = await shareAndJoin(app, id, "carol");
    expect(second.token).not.toBe(first.token);
    expect((await send(app, "bob", "POST", first.joinPath)).status).toBe(404);
    const write = await send(app, "carol", "POST", `/api/wishlists/${id}/items`, {
      productId: "p-106",
    });
    expect(write.status).toBe(201);
  });

  test("authorization: removing a collaborator denies their writes", async () => {
    const { app, id } = await setup();
    await shareAndJoin(app, id, "bob");
    await shareAndJoin(app, id, "carol");
    const removed = await send(app, "alice", "DELETE", `/api/wishlists/${id}/collaborators/bob`);
    expect(removed.status).toBe(200);
    const write = await send(app, "bob", "POST", `/api/wishlists/${id}/items`, {
      productId: "p-100",
    });
    expect(write.status).toBe(403);
    expect((await send(app, "bob", "GET", `/api/wishlists/${id}`)).status).toBe(403);
    // Carol still has access.
    const carol = await send(app, "carol", "POST", `/api/wishlists/${id}/items`, {
      productId: "p-100",
    });
    expect(carol.status).toBe(201);
  });
});
