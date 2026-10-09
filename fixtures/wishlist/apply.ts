import { DESIGNS, type DeclaredIntent, type WishlistDesign } from "./manifest.ts";

/**
 * Applies one wishlist design to a checkout of the canonical Acme Shop source. Pure: the caller
 * supplies the fixture files and reads the base. Used by the integration Worker (which commits the
 * result to an Artifacts fork) and by `bun run demo:wishlist --local` (which runs the checks).
 */

export type DesignChanges = {
  /** Repository path to new full content, for every added or edited file. */
  files: Record<string, string>;
  added: string[];
  modified: string[];
  intent: DeclaredIntent;
};

/**
 * @param fixture Fixture files keyed by path relative to `fixtures/wishlist` (`files/shared/...`).
 * @param readBase Returns the base content of a repository file, or null when it does not exist.
 * Throws when an edit anchor is missing or ambiguous, or when an added file already exists: the
 * fixture then does not apply to this base, and nothing must be committed.
 */
export function applyDesign(
  design: WishlistDesign,
  fixture: Readonly<Record<string, string>>,
  readBase: (path: string) => string | null,
): DesignChanges {
  const spec = DESIGNS[design];
  const files: Record<string, string> = {};
  const added: string[] = [];
  for (const source of spec.sources) {
    const prefix = `files/${source}/`;
    for (const [key, content] of Object.entries(fixture)) {
      if (!key.startsWith(prefix)) continue;
      const path = key.slice(prefix.length);
      if (!(path in files)) {
        if (readBase(path) !== null) throw new Error(`${path} already exists in the base`);
        added.push(path);
      }
      files[path] = content;
    }
  }
  if (added.length === 0) throw new Error(`fixture design ${design} has no files`);

  const modified: string[] = [];
  for (const edit of spec.edits) {
    const current = files[edit.path] ?? readBase(edit.path);
    if (current === null || current === undefined) throw new Error(`${edit.path} is missing`);
    const at = current.indexOf(edit.find);
    if (at === -1 || current.indexOf(edit.find, at + 1) !== -1) {
      throw new Error(`${edit.path}: anchor not found exactly once: ${JSON.stringify(edit.find)}`);
    }
    files[edit.path] = current.slice(0, at) + edit.replace + current.slice(at + edit.find.length);
    if (!modified.includes(edit.path)) modified.push(edit.path);
  }

  const expectedFiles = [...added, ...modified].sort();
  return {
    files,
    added: added.sort(),
    modified: modified.sort(),
    intent: { ...spec.intent, expectedFiles },
  };
}
