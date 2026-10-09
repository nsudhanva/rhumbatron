import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";

const start = createStartHandler(defaultStreamHandler);

/**
 * Server entry. `www.` hosts redirect permanently to the apex (ADR 0017): the Worker serves
 * `www.rhumbatron.com` itself, so the zone needs no redirect ruleset.
 */
export default createServerEntry({
  fetch(request: Request, ...rest: unknown[]) {
    const url = new URL(request.url);
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    return (start as (request: Request, ...rest: unknown[]) => Promise<Response>)(request, ...rest);
  },
});
