/** Plain status pages of the apps router (ADR 0020). No scripts, no cookies, no external assets. */

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(status: number, title: string, body: string, extra: Record<string, string> = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${status === 503 ? '<meta http-equiv="refresh" content="10">' : ""}
<title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1.5rem;color:#1f2328}
h1{font-size:1.25rem}p{color:#57606a}a{color:#0969da}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>
<p><a href="https://rhumbatron.com">Rhumbatron</a></p></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      ...extra,
    },
  });
}

export const notFoundPage = () =>
  page(404, "No app here", "No Rhumbatron app is published at this address.");

export const removedPage = () =>
  page(410, "App removed", "This app was removed. Its code and data are deleted.");

export const buildingPage = () =>
  page(503, "Building", "This app is building. The page reloads in a few seconds.", {
    "retry-after": "10",
  });

/** A Project with no app code yet: an empty repository before its first Change ships. */
export const emptyPage = () => page(200, "Nothing built yet", "Tell Rhumbatron what to make.");

export const failedPage = (reason: string) =>
  page(503, "Build failed", `The latest build of this app failed: ${reason.slice(0, 300)}`, {
    "retry-after": "60",
  });

export const limitPage = () =>
  page(
    503,
    "App limit reached",
    "This request used more CPU time or subrequests than an app may.",
    {
      "retry-after": "5",
    },
  );

export const errorPage = () => page(502, "App error", "The app failed to answer this request.");
