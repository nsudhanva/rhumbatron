/**
 * rhumbatron-apps (prod only, ADR 0020): serves every Project as a live app on its own
 * rhumbatron.com subdomain through Dynamic Workers, and builds app bundles for the integration
 * Worker. Exports:
 *
 * - default: the router (fetch).
 * - AppBuilder: bundle builder RPC (service binding `APPS` on the integration Worker).
 * - AppAssets, AppData: the ASSETS and DATA bindings that the router passes to each app.
 * - AppDataDO: SQLite store behind DATA, one per app (and per preview).
 */
import { routeAppRequest } from "./router.ts";

export { AppAssets } from "./assets.ts";
export { AppBuilder } from "./builder.ts";
export { AppChecker } from "./checker.ts";
export { AppData, AppDataDO } from "./data.ts";

export default {
  fetch: routeAppRequest,
} satisfies ExportedHandler<Env>;
