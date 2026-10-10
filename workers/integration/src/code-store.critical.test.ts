import type { CodeManifest } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { selectCanonicalFiles } from "./code-store.ts";
import { isEmptyRepository } from "./root-planner.ts";

const S0 = "a".repeat(40);
const S1 = "b".repeat(40);
const index = (treeSha: string, files: string[]) => ({ treeSha, commit: "c".repeat(40), files });
const manifest = (treeSha: string, files: string[]): CodeManifest => ({
  treeSha,
  commit: "c".repeat(40),
  complete: false,
  entries: files.map((path) => ({ path, blob: "d".repeat(40), size: null, stored: false })),
});

describe("planner files from the current canonical tree", () => {
  it("uses S1 code paths even when the index still describes the blank S0 tree", () => {
    const files = selectCanonicalFiles(
      S1,
      manifest(S1, [".gitignore", "package.json", "src/app.ts"]),
      index(S0, [".gitignore"]),
    );
    expect(files).toEqual([".gitignore", "package.json", "src/app.ts"]);
    expect(isEmptyRepository(files)).toBe(false);
  });

  it("uses only a matching tree index when the code manifest is absent or stale", () => {
    const current = index(S1, ["package.json"]);
    expect(selectCanonicalFiles(S1, null, current)).toEqual(["package.json"]);
    expect(selectCanonicalFiles(S1, manifest(S0, [".gitignore"]), current)).toEqual([
      "package.json",
    ]);
    const unknown = selectCanonicalFiles(
      S1,
      manifest(S0, [".gitignore"]),
      index(S0, [".gitignore"]),
    );
    expect(unknown).toBeNull();
    expect(isEmptyRepository(unknown)).toBe(false);
  });

  it("preserves an empty current tree instead of borrowing an older app's files", () => {
    expect(selectCanonicalFiles(S1, manifest(S1, []), index(S0, ["package.json"]))).toEqual([]);
    expect(selectCanonicalFiles(S1, null, index(S1, []))).toEqual([]);
    expect(isEmptyRepository(selectCanonicalFiles(S1, manifest(S1, []), null))).toBe(true);
  });

  it("treats a missing or malformed index as unknown source", () => {
    expect(selectCanonicalFiles(S1, null, null)).toBeNull();
    expect(selectCanonicalFiles(S1, null, { treeSha: S1, files: [null] })).toBeNull();
    expect(selectCanonicalFiles(S1, null, { files: [".gitignore"] })).toBeNull();
  });
});
