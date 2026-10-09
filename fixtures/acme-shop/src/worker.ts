import { createApp } from "./app";
import { createStore } from "./store";

// Cloudflare Worker entry for releases. Static files come from the assets in public/; this handles
// the API. The store is in memory per isolate: demo data, reset when the isolate restarts.
const app = createApp(createStore());

export default {
  fetch: (request: Request) => app.fetch(request),
};
