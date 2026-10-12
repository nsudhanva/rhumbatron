import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { isApprovalRequired } from "./lib/access";
import { ME_KEY } from "./lib/api-budget";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  // Server-rendered data (lib/ssr-data.ts) is a few seconds old when the page hydrates: a short
  // stale time keeps the first client render from reading it again at once. Live pushes and
  // mutations invalidate queries regardless of this value.
  //
  // A 403 `approval_required` from any read or command means the account lost its approval while
  // the page was open: read `GET /v1/me` again, and the access gate replaces the app
  // (lib/access.ts, components/shell/access-gate.tsx).
  const onError = (error: unknown) => {
    if (isApprovalRequired(error)) void queryClient.invalidateQueries({ queryKey: ME_KEY });
  };
  const queryClient: QueryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 10_000 } },
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
  });
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
