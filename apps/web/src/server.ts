import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";

const start = createStartHandler(defaultStreamHandler);

/**
 * Starts the client entry module after the first contentful paint. The server-rendered page is
 * complete without JavaScript, so the stylesheet and fonts get the connection first and the page
 * paints before about 300 kB of JavaScript arrives. The loader puts the same `<script>` element
 * back in the same place, so hydration sees the markup it expects. After 3 s it starts anyway.
 */
function entryLoader(src: string): string {
  return `<script>(function(s){var d=0;function go(){if(d)return;d=1;var m=document.createElement("script");m.type="module";m.setAttribute("async","");m.src=${JSON.stringify(src)};s.replaceWith(m)}var P=window.PerformanceObserver;if(P&&P.supportedEntryTypes&&P.supportedEntryTypes.indexOf("paint")>=0){var o=new P(function(l){if(l.getEntriesByName("first-contentful-paint").length){o.disconnect();go()}});o.observe({type:"paint",buffered:true})}else{requestAnimationFrame(function(){setTimeout(go,0)})}setTimeout(go,3000)})(document.currentScript)</script>`;
}

function deferEntryScript(response: Response): Response {
  if (!response.headers.get("content-type")?.startsWith("text/html")) return response;
  return new HTMLRewriter()
    .on('script[type="module"][src^="/assets/"]', {
      element(element) {
        const src = element.getAttribute("src");
        if (src) element.replace(entryLoader(src), { html: true });
      },
    })
    .transform(response);
}

/**
 * Server entry. `www.` hosts redirect permanently to the apex (ADR 0017): the Worker serves
 * `www.rhumbatron.com` itself, so the zone needs no redirect ruleset.
 */
export default createServerEntry({
  async fetch(request: Request, ...rest: unknown[]) {
    const url = new URL(request.url);
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    const response = await (start as (request: Request, ...rest: unknown[]) => Promise<Response>)(
      request,
      ...rest,
    );
    return deferEntryScript(response);
  },
});
