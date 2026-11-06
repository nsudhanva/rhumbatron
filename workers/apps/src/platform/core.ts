/**
 * Transport to the core service on the self-hosted stack (services/apps/CONTRACT.md). The `CORE`
 * binding is a workerd external service (`core:8790`); only the platform Worker has it. Apps loaded
 * through LOADER never see it.
 */
export type CoreLink = { core: Fetcher; token: string };

/** Origin for internal URLs. The external service ignores the host; the path is what counts. */
const ORIGIN = "http://core:8790";

export async function coreFetch(
  link: CoreLink,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${link.token}`);
  return link.core.fetch(`${ORIGIN}${path}`, { ...init, headers });
}

/** Throws with the core's error text on any status outside `ok`. */
export async function expectOk(response: Response, what: string, ok = [200]): Promise<Response> {
  if (ok.includes(response.status)) return response;
  const text = await response.text().catch(() => "");
  throw new Error(`${what}: core answered ${response.status} ${text.slice(0, 300)}`);
}
