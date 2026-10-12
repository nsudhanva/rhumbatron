# ADR 0027: Server-rendered page data and the phone text floor

## Context

The web app renders on the server, but signed-in pages read their data in the browser after
hydration. The first paint shows skeletons. On a phone, Lighthouse measures the largest contentful
paint at 3 to 8 seconds, and most of that time is render delay. When the data arrives, sections
change height, and the page shifts (cumulative layout shift up to 0.59). Labels of 10 and 11px
fail the legible text audit on phone widths.

## Decision

- Each signed-in route has a `loader` that reads the page's primary data into the router's
  QueryClient on the server (`apps/web/src/lib/ssr-data.ts`). The router's SSR query integration
  writes the cache into the HTML. The components read the same query keys with the same server
  functions, so their first render has the data. On the client, the loaders do nothing. A
  client-side navigation renders at once, and the components read their data in the browser.
- The server functions call the API Worker with the user's Clerk session during the server render.
  A failed read stays in the cache as an error. The page shows its error state and the client
  reads again.
- The event feeds and the Project timeline start from the first page that the loader read. Their
  first client read takes only newer rows.
- The QueryClient stale time is 10 seconds, so the hydration does not read the same data again.
  Live pushes and mutations invalidate queries.
- Text that the server and the hydration must print the same way reads one instant and one time
  zone (`apps/web/src/lib/render-time.ts`). A head script stores the browser's time zone in the
  `rh-tz` cookie. The server formats clock times in that zone and writes the zone and the request
  instant to `<html data-tz data-now>`. The client uses them until the page has hydrated.
- The shell derives every breadcrumb that the route and its search name, so the server renders
  the header at its final height.
- The sign-in and sign-up pages show a placeholder card with the size of Clerk's card until
  Clerk's script mounts the real card.
- Below the Tailwind `sm` breakpoint (640px), no text is smaller than 12px (`theme.css`, "Phone
  text floor"). From 640px up, labels keep their standard sizes.

## Consequences

- The time to first byte of a signed-in page includes its slowest primary read. The loader runs
  independent reads in parallel.
- The server render makes the API reads of the first page view. Hover preloads make no reads.
  The Project overview makes up to 27 service-binding calls in one render: 7 page reads and one
  Task read for each of the newest 20 Changes.
- On a first visit without the `rh-tz` cookie, clock times show in UTC until the next full page
  load.
- Clerk's Google icon (`img.clerk.com`) sets a third-party `__cf_bm` cookie on the sign-in page.
  The web app does not control this cookie, and Lighthouse reports it under Best Practices.
