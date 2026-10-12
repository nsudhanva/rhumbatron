import { env } from "cloudflare:workers";
import { ClerkProvider } from "@clerk/tanstack-react-start";
import { LinkProvider } from "@cloudflare/kumo";
import archivo400 from "@fontsource/archivo/files/archivo-latin-400-normal.woff2?url";
import archivo600 from "@fontsource/archivo/files/archivo-latin-600-normal.woff2?url";
import archivo800 from "@fontsource/archivo/files/archivo-latin-800-normal.woff2?url";
import type { QueryClient } from "@tanstack/react-query";
import {
  Asset,
  createRootRouteWithContext,
  Link,
  Outlet,
  Scripts,
  useRouter,
  useTags,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type AnchorHTMLAttributes, forwardRef, type ReactNode, useEffect } from "react";
import { AppShell } from "../components/shell/app-shell";
import { PageMetaProvider } from "../components/shell/page-meta";
import { LiveStatusProvider } from "../lib/live-status";
import { MODE_BOOT_SCRIPT } from "../lib/mode";
import { PRE_HYDRATION_SCRIPT, replayPreHydrationInput } from "../lib/pre-hydration";
import {
  displayTimeZone,
  markHydrated,
  renderNow,
  TIME_ZONE_BOOT_SCRIPT,
} from "../lib/render-time";
import appCss from "../styles.css?url";

// Build and environment are shown on every page, in the status bar.
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
      {
        name: "description",
        content:
          "Rhumbatron lets many agents propose many futures of one codebase. Only verified evidence advances the canonical state.",
      },
      // Light is the default mode (the boot script applies a stored dark choice).
      // The ground color: meta tags cannot read CSS tokens.
      { name: "color-scheme", content: "light" },
      { name: "theme-color", content: "#f3f2f2" },
    ],
    links: [
      // Archivo 400/600 carry almost all text and 800 sets the wordmark and page titles, all
      // above the fold; fetch them with the stylesheet, not after it.
      // Production only: the dev server serves the stylesheet's fonts from another URL.
      ...(import.meta.env.PROD ? [archivo400, archivo600, archivo800] : []).map((href) => ({
        rel: "preload",
        as: "font",
        type: "font/woff2",
        href,
        crossOrigin: "anonymous" as const,
      })),
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
    ],
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

/**
 * `HeadContent` with the router's module preloads at low fetch priority. TanStack Start preloads
 * every chunk of the matched routes (about 240 kB gzipped). In the first HTML the server entry
 * holds them until the first contentful paint (src/server.ts), so the stylesheet and fonts load
 * alone; then they download in parallel with the entry script, at low priority.
 */
function RouteHead() {
  const tags = useTags().map((tag) =>
    tag.tag === "link" && tag.attrs?.rel === "modulepreload"
      ? { ...tag, attrs: { ...tag.attrs, fetchPriority: "low" } }
      : tag,
  );
  const nonce = useRouter().options.ssr?.nonce;
  return (
    <>
      {tags.map((tag) => (
        <Asset {...tag} key={`tsr-meta-${JSON.stringify(tag)}`} {...(nonce ? { nonce } : {})} />
      ))}
    </>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  // Runs after the whole page has hydrated: adopt text typed into server-rendered fields, and
  // let later renders read the real clock (lib/render-time.ts).
  useEffect(() => {
    markHydrated();
    replayPreHydrationInput();
  }, []);
  return (
    // The boot script sets data-mode before hydration, so the server value may differ. data-tz
    // and data-now carry the server render's time zone and instant to the hydration.
    <html
      lang="en"
      data-mode="light"
      data-tz={displayTimeZone()}
      data-now={renderNow()}
      suppressHydrationWarning
    >
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static script that applies the stored color mode before first paint
          dangerouslySetInnerHTML={{ __html: MODE_BOOT_SCRIPT }}
        />
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static script that keeps text typed before hydration
          dangerouslySetInnerHTML={{ __html: PRE_HYDRATION_SCRIPT }}
        />
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static script that stores the browser's time zone for server-rendered clock times
          dangerouslySetInnerHTML={{ __html: TIME_ZONE_BOOT_SCRIPT }}
        />
        <RouteHead />
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
