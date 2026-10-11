import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  // Server-rendered data (lib/ssr-data.ts) is a few seconds old when the page hydrates: a short
  // stale time keeps the first client render from reading it again at once. Live pushes and
  // mutations invalidate queries regardless of this value.
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
  });
  setupRouterSsrQueryIntegration({
    router,
    queryClient,
    // Only data goes into the HTML. A failed or unfinished server read is left out, and the
    // client reads it again (a dehydrated error or promise would reject in the page).
    dehydrateOptions: { shouldDehydrateQuery: (query) => query.state.status === "success" },
  });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
