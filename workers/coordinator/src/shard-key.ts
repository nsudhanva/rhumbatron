/**
 * Stable shard key for ResourceShardDO (AGENTS.md section 13.2).
 * Pure function. The same inputs always map to the same shard, in every producer.
 */

const DEFAULT_SHARD_COUNT = 32;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32-bit hash over UTF-8 bytes. Returns an unsigned integer. */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * Returns `${projectId}:shard-NN`. Use it as the Durable Object name:
 * `env.RESOURCE_SHARD.idFromName(shardKey(projectId, resource))`.
 */
export function shardKey(
  projectId: string,
  resource: string,
  shardCount = DEFAULT_SHARD_COUNT,
): string {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new RangeError("shardCount must be a positive integer");
  }
  const index = fnv1a32(`${projectId}\u0000${resource}`) % shardCount;
  return `${projectId}:shard-${String(index).padStart(2, "0")}`;
}
