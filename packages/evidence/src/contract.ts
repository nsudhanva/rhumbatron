import { contractKey, contractKeys } from "./compatibility.ts";

/**
 * Contract check (AGENTS.md section 34.1): every route the Candidate adds or removes against its
 * base must be declared by one of its ChangeSets. Declared changes match by `contractKey`; one declaration can name several routes.
 */
export type ContractDiff = {
  added: string[];
  removed: string[];
  /** Observed changes that no ChangeSet declared. Any entry fails the check. */
  undeclared: string[];
};

/** Reads the last `{"routes": [...]}` line of `bun run contract` output. Null when absent. */
export function parseRouteTable(stdout: string): string[] | null {
  for (const raw of stdout.split(/\r?\n/).reverse()) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      const routes = (JSON.parse(line) as { routes?: unknown }).routes;
      if (Array.isArray(routes) && routes.every((r) => typeof r === "string")) return routes;
    } catch {
      // Not JSON: keep looking at earlier lines.
    }
  }
  return null;
}

export function diffContract(
  base: string[],
  candidate: string[],
  declared: string[],
): ContractDiff {
  const before = new Set(base);
  const after = new Set(candidate);
  const added = [...after].filter((r) => !before.has(r)).sort();
  const removed = [...before].filter((r) => !after.has(r)).sort();
  const declaredKeys = new Set(declared.flatMap(contractKeys));
  const undeclared = [...added, ...removed].filter((r) => !declaredKeys.has(contractKey(r)));
  return { added, removed, undeclared };
}
