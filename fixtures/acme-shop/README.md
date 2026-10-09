# Acme Shop

Demo codebase that Rhumbatron agents change (AGENTS.md section 54). Bun + Hono, in-memory store.

- Catalog: `GET /api/products`, `GET /api/products/:id`
- Cart: `GET /api/cart`, `POST /api/cart/items`, `PATCH /api/cart/items/:productId`, `DELETE /api/cart/items/:productId`
- Identity fixture: header `x-user-id` with `alice`, `bob`, or `carol`

```sh
bun install
bun test        # includes the protected Cart invariant
bun run bench   # prints {"p95Ms": n} for GET /api/cart
bun run dev     # http://localhost:8787
```

Release: `src/worker.ts` and `wrangler.jsonc` deploy the shop as the `rhumbatron-acme-shop-dev` Worker. Workers Builds builds it on each push to `main`, which Rhumbatron makes when it promotes a Candidate.

Protected invariant: existing cart add, remove, quantity, and total behavior must remain unchanged.
