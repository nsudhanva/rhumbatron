import { env } from "cloudflare:workers";
import { ClerkProvider } from "@clerk/tanstack-react-start";
import { LinkProvider } from "@cloudflare/kumo";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type AnchorHTMLAttributes, forwardRef, type ReactNode } from "react";
import { AppShell } from "../components/shell/app-shell";
import { PageMetaProvider } from "../components/shell/page-meta";
import { LiveStatusProvider } from "../lib/live-status";
import { MODE_BOOT_SCRIPT } from "../lib/mode";
import appCss from "../styles.css?url";

// Build and environment are shown on every page (AGENTS.md Phase 2 acceptance), in the status bar.
const getBuildInfo = createServerFn().handler(() => ({
  service: env.SERVICE_NAME,
  environment: env.ENVIRONMENT,
}));

type RouterContext = {
  queryClient: QueryClient;
};

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Rhumbatron" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  loader: () => getBuildInfo(),
  component: RootComponent,
});

function RootComponent() {
  const build = Route.useLoaderData();
  return (
    <RootDocument>
      <AppShell build={build}>
        <Outlet />
      </AppShell>
    </RootDocument>
  );
}

/**
 * Routes Kumo's `Link`, `LinkButton` and `Breadcrumbs.Link` through the TanStack router for
 * same-origin paths. External URLs and in-page anchors stay plain anchors.
 */
const RouterLink = forwardRef<
  HTMLAnchorElement,
  AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string }
>(function RouterLink({ href, to, target, ...rest }, ref) {
  const path = href ?? to;
  if (!path?.startsWith("/") || path.startsWith("//")) {
    return <a ref={ref} href={path} target={target} {...rest} />;
  }
  // A runtime path string: the router resolves it, so the typed route union does not apply.
  return <Link ref={ref} to={path as "/"} {...(target ? { target } : {})} {...rest} />;
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    // The boot script sets data-mode before hydration, so the server value may differ.
    <html lang="en" data-mode="light" suppressHydrationWarning>
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static script that applies the stored color mode before first paint
          dangerouslySetInnerHTML={{ __html: MODE_BOOT_SCRIPT }}
        />
        <HeadContent />
      </head>
      <body>
        <ClerkProvider>
          <LinkProvider component={RouterLink}>
            <LiveStatusProvider>
              <PageMetaProvider>{children}</PageMetaProvider>
            </LiveStatusProvider>
          </LinkProvider>
          <Scripts />
        </ClerkProvider>
      </body>
    </html>
  );
}
