/**
 * Prints the API route table as one JSON line: {"routes":["GET /api/cart", ...]}.
 * CONTRACT_ROOT reads another checkout (the base commit) with this checkout's dependencies.
 */
const root = process.env.CONTRACT_ROOT ?? process.cwd();
const { createApp } = await import(`${root}/src/app.ts`);
const { createStore } = await import(`${root}/src/store.ts`);

const app = createApp(createStore()) as { routes: { method: string; path: string }[] };
const routes = [
  ...new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`)),
].sort();
process.stdout.write(`${JSON.stringify({ routes })}\n`);

export {};
