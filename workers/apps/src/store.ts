import { AppBundle, type AppBundle as AppBundleType, bundleObjectKey } from "./bundle.ts";

/**
 * Bundle reads for the router and the asset binding. A bundle never changes after it is written
 * (content-addressed by commit), so an isolate keeps parsed bundles until it restarts. The cap
 * bounds memory: a bundle is at most about 10 MB of modules.
 */
const MAX_CACHED_BUNDLES = 8;
const bundles = new Map<string, AppBundleType>();

export async function loadBundle(bucket: R2Bucket, key: string): Promise<AppBundleType | null> {
  const hit = bundles.get(key);
  if (hit) return hit;
  const object = await bucket.get(bundleObjectKey(key));
  if (!object) return null;
  const bundle = AppBundle.parse(await object.json());
  if (bundles.size >= MAX_CACHED_BUNDLES) bundles.delete(bundles.keys().next().value ?? "");
  bundles.set(key, bundle);
  return bundle;
}
