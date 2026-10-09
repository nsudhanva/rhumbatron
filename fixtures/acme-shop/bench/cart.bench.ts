import { createApp } from "../src/app";
import { createStore } from "../src/store";

const N = Number(process.env.BENCH_N ?? 2000);
const app = createApp(createStore());
const headers = { "x-user-id": "alice", "content-type": "application/json" };

await app.request("/api/cart/items", {
  method: "POST",
  headers,
  body: JSON.stringify({ productId: "p-100", quantity: 2 }),
});

const samples: number[] = [];
for (let i = 0; i < N; i++) {
  const start = performance.now();
  await app.request("/api/cart", { headers });
  samples.push(performance.now() - start);
}

samples.sort((a, b) => a - b);
const p95Ms = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] ?? 0;
process.stdout.write(`${JSON.stringify({ p95Ms })}\n`);
