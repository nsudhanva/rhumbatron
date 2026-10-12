/**
 * Wishlist design-conflict fixture. Two complete, independently verifiable implementations of
 * shared wishlists on top of `fixtures/acme-shop`:
 *
 * - Design A: normalized mutable collaborator membership table. Access is derived from the table on
 *   every request, so a read costs O(membership rows) per check and the item list does one check
 *   per item. On the benchmark dataset this misses the p95 budget.
 * - Design B: append-only membership event log with a materialized current-member set. Reads use
 *   the set directly and pass the budget.
 *
 * Both designs have the same HTTP contract, acceptance tests, and benchmark (`files/shared`), and
 * each declares the Intent an agent would declare for it. Fixture-sourced: no model produced them.
 */

export type WishlistDesign = "a" | "b";

/** Text replacement in an existing canonical file. `find` must occur exactly once. */
export type SourceEdit = { path: string; find: string; replace: string };

/** The `complete_task` Intent declaration, as agents store it in `changesets.intent_json`. */
export type DeclaredIntent = {
  summary: string;
  semanticResources: string[];
  expectedFiles: string[];
  expectedContractChanges: string[];
  expectedDataChanges: string[];
  assumptions: string[];
  acceptanceEvidence: string[];
};

export type DesignFixture = {
  design: WishlistDesign;
  /** Work Graph task key; Task, run, fork, and ChangeSet IDs derive from it. */
  taskKey: string;
  title: string;
  objective: string;
  agentId: string;
  /** Directories under `files/` copied into the repo root, in order. */
  sources: string[];
  edits: SourceEdit[];
  intent: Omit<DeclaredIntent, "expectedFiles">;
  commitMessage: string;
};

/** The demo user goal, word for word. */
export const WISHLIST_GOAL =
  "Add shared wishlists. Users can create a wishlist, share it with a link, and let collaborators " +
  "add or remove products. Keep existing cart behavior unchanged. Keep API p95 below 200 ms.";

/** The Work Graph facts a planner would record for the Wishlist Change. */
export const CHANGE_PLAN = {
  riskTier: "high",
  acceptanceCriteria: [
    "A user can create a wishlist.",
    "The owner can share a wishlist with a link.",
    "Collaborators who join through the link can add and remove products.",
    "Revoking the link denies later collaborator writes.",
    "Wishlist API p95 stays below 200 ms in the demo benchmark.",
  ],
  invariants: ["Existing cart add, remove, quantity, and total behavior must remain unchanged."],
} as const;

/** Wiring both designs share: the store holds wishlist state, the app mounts the routes. */
const EDITS: SourceEdit[] = [
  {
    path: "src/store.ts",
    find: 'import type { UserId } from "./identity";\n',
    replace:
      'import type { UserId } from "./identity";\n' +
      'import { createWishlistState, type WishlistState } from "./wishlist/model";\n',
  },
  {
    path: "src/store.ts",
    find: "  carts: Map<UserId, Cart>;\n",
    replace: "  carts: Map<UserId, Cart>;\n  wishlists: WishlistState;\n",
  },
  {
    path: "src/store.ts",
    find: "    carts: new Map(),\n",
    replace: "    carts: new Map(),\n    wishlists: createWishlistState(),\n",
  },
  {
    path: "src/app.ts",
    find: 'import { getCart, type Store, setCart } from "./store";\n',
    replace:
      'import { getCart, type Store, setCart } from "./store";\n' +
      'import { registerWishlistRoutes } from "./wishlist/routes";\n',
  },
  {
    path: "src/app.ts",
    find: "\n  return app;\n}\n",
    replace: "\n  registerWishlistRoutes(app, store);\n\n  return app;\n}\n",
  },
  {
    path: "package.json",
    find: '"bench": "bun run bench/cart.bench.ts",',
    replace: '"bench": "bun run bench/api.bench.ts",',
  },
  {
    path: "public/index.html",
    find: "    <h1>Acme Shop</h1>\n",
    replace: '    <h1>Acme Shop</h1>\n    <p><a href="/wishlist.html">Wishlists</a></p>\n',
  },
  {
    path: "README.md",
    find: "- Identity fixture:",
    replace:
      "- Wishlists: `POST /api/wishlists`, `GET /api/wishlists/:id`, `POST|DELETE /api/wishlists/:id/share`, " +
      "`POST /api/wishlist-links/:token/join`, `POST /api/wishlists/:id/items`, " +
      "`DELETE /api/wishlists/:id/items/:productId`, `DELETE /api/wishlists/:id/collaborators/:userId`\n" +
      "- Identity fixture:",
  },
];

/** Same routes and response shapes in both designs: the contract is not where they differ. */
const CONTRACT = [
  "POST /api/wishlists - add: create a wishlist {name} returns {WishlistView}",
  "GET /api/wishlists/:id - add: read a wishlist as owner or collaborator {WishlistView}",
  "POST /api/wishlists/:id/share - add: owner creates or returns the share link {token,joinPath}",
  "DELETE /api/wishlists/:id/share - add: owner revokes the share link {WishlistView}",
  "POST /api/wishlist-links/:token/join - add: join as editor through a share link {WishlistView}",
  "POST /api/wishlists/:id/items - add: owner or collaborator adds a product {productId} returns {WishlistView}",
  "DELETE /api/wishlists/:id/items/:productId - add: owner or collaborator removes a product {WishlistView}",
  "DELETE /api/wishlists/:id/collaborators/:userId - add: owner removes a collaborator {WishlistView}",
];

const EVIDENCE = [
  "bun run typecheck",
  "bun test",
  "bun test --test-name-pattern authorization",
  "bun run contract",
  "bun run bench",
];

export const DESIGNS: Record<WishlistDesign, DesignFixture> = {
  a: {
    design: "a",
    taskKey: "wishlist-membership-table",
    title: "Shared wishlists on a normalized collaborator table",
    objective:
      "Implement shared wishlists with normalized, mutable relational tables for wishlists, " +
      "collaborator memberships, share links, and items.",
    agentId: "fixture-design-a",
    sources: ["shared", "design-a"],
    edits: EDITS,
    intent: {
      summary:
        "Shared wishlists on normalized mutable tables: wishlist_collaborators rows are updated " +
        "in place on remove and revoke, and access is read from the table on each request.",
      semanticResources: ["wishlist:membership", "wishlist:items"],
      expectedContractChanges: CONTRACT,
      expectedDataChanges: [
        "Add `wishlist_collaborators` table (wishlist_id, user_id, role, via_link, active): normalized mutable rows, updated in place on remove and revoke",
        "Add `wishlists`, `wishlist_share_links`, and `wishlist_items` tables: normalized rows",
      ],
      assumptions: [
        "Membership changes are rare compared with wishlist reads.",
        "Effective access is recomputed from the collaborator table on every request.",
        "Revoking a share link updates the collaborator rows that joined through it in place.",
      ],
      acceptanceEvidence: EVIDENCE,
    },
    commitMessage: "Shared wishlists: normalized mutable collaborator table (fixture design A)",
  },
  b: {
    design: "b",
    taskKey: "wishlist-membership-log",
    title: "Shared wishlists on an append-only membership log",
    objective:
      "Implement shared wishlists with an append-only membership event log and a materialized " +
      "current-member set.",
    agentId: "fixture-design-b",
    sources: ["shared", "design-b"],
    edits: EDITS,
    intent: {
      summary:
        "Shared wishlists on an append-only membership event log: joins, removals, and link " +
        "revocations are appended, and reads use a materialized current-member set.",
      semanticResources: ["wishlist:membership", "wishlist:items"],
      expectedContractChanges: CONTRACT,
      expectedDataChanges: [
        "Add `wishlist_membership_events` append-only event log (created, joined, removed, link_created, link_revoked) ordered by seq; the current-member set is materialized from it",
        "Add `wishlists` registry and `wishlist_items` key-value sets per wishlist",
      ],
      assumptions: [
        "Membership changes can be frequent and concurrent.",
        "Reads use the materialized current-member set and never recompute access from history.",
        "Revoking a share link appends an event; earlier events are never changed.",
      ],
      acceptanceEvidence: EVIDENCE,
    },
    commitMessage: "Shared wishlists: append-only membership log (fixture design B)",
  },
};

/** IDs one design gets on one Change, in the agents' formats (dispatch.ts, agent-do.ts). */
export function fixtureIds(changeId: string, design: WishlistDesign) {
  const taskId = `tsk_${changeId.slice(4)}_${DESIGNS[design].taskKey}`;
  const run = `${taskId.slice(4)}_1`;
  return {
    taskId,
    runId: `run_${run}`,
    fork: `ws-${run}`,
    changeSetId: `cs_${run}`,
    intentId: `int_${run}`,
  };
}
