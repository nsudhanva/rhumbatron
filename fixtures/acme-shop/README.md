# Acme Shop

Demo codebase that Rhumbatron agents change (AGENTS.md section 54). Bun + Hono, in-memory store.

- Catalog: `GET /api/products`, `GET /api/products/:id`
- Cart: `GET /api/cart`, `POST /api/cart/items`, `PATCH /api/cart/items/:productId`, `DELETE /api/cart/items/:productId`
- Identity fixture: fake, no real login. Header `x-user-id` or cookie `acme_user` with `alice`, `bob`, or `carol`; with neither, the demo user `alice`

```sh
bun install
bun test        # includes the protected Cart invariant
bun run bench   # prints {"p95Ms": n} for GET /api/cart
bun run dev     # http://localhost:8787
```

Live app: `src/worker.ts` and `wrangler.jsonc` are what the apps builder bundles when Rhumbatron releases this codebase as a live app (ADR 0020).

Protected invariant: existing cart add, remove, quantity, and total behavior must remain unchanged.
