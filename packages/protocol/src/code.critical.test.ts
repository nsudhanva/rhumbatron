import { describe, expect, it } from "vitest";
import { boundPatch, patchCommand, splitPatch } from "./code.ts";

const SHA = "a".repeat(40);

const PATCH = [
  "diff --git a/src/cart.ts b/src/cart.ts",
  "index 1111111..2222222 100644",
  "--- a/src/cart.ts",
  "+++ b/src/cart.ts",
  "@@ -1,3 +1,4 @@",
  " export const a = 1;",
  "-export const b = 2;",
  "+export const b = 3;",
  "+export const c = 4;",
  "diff --git a/src/wishlist.ts b/src/wishlist.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/wishlist.ts",
  "@@ -0,0 +1,2 @@",
  "+--- not a header",
  "++++ also not a header",
  "diff --git a/old.ts b/old.ts",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/old.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
  "diff --git a/docs/a.md b/docs/b.md",
  "similarity index 100%",
  "rename from docs/a.md",
  "rename to docs/b.md",
  "diff --git a/logo.png b/logo.png",
  "index 5555555..6666666 100644",
  "Binary files a/logo.png and b/logo.png differ",
  "",
].join("\n");

describe("patch bounds", () => {
  it("reads the size line and keeps a patch under the limit whole", () => {
    expect(boundPatch(`12\n${"x".repeat(11)}\n`, 100)).toEqual({
      patch: `${"x".repeat(11)}\n`,
      bytes: 12,
      truncated: false,
    });
  });

  it("cuts a large patch at the last whole line and reports the full size", () => {
    const body = "line-one\nline-two\nline-three\n";
    const bounded = boundPatch(`5000\n${body}`, 20);
    expect(bounded).toEqual({ patch: "line-one\nline-two\n", bytes: 5000, truncated: true });
  });

  it("marks truncation when only the reported size exceeds the limit", () => {
    // `head -c` already cut the stream: the text fits, but the diff was larger.
    expect(boundPatch("900\nabc\n", 10)).toMatchObject({ truncated: true, bytes: 900 });
  });

  it("counts UTF-8 bytes, not UTF-16 units, and never splits a multibyte line", () => {
    const line = `${"é".repeat(5)}\n`; // 11 bytes
    const bounded = boundPatch(`22\n${line}${line}`, 15);
    expect(bounded.patch).toBe(line);
    expect(bounded.truncated).toBe(true);
  });

  it("returns nothing rather than a partial first line", () => {
    expect(boundPatch(`50\n${"x".repeat(50)}`, 10)).toEqual({
      patch: "",
      bytes: 50,
      truncated: true,
    });
  });

  it("only builds a diff command for full commit IDs", () => {
    expect(patchCommand(SHA, "HEAD")).toContain(`git diff --no-color --no-ext-diff -M ${SHA} HEAD`);
    expect(() => patchCommand("HEAD~1; rm -rf /", "HEAD")).toThrow();
    expect(() => patchCommand(SHA, "$(id)")).toThrow();
  });

  it("leaves out only plain generated paths", () => {
    expect(patchCommand(SHA, "HEAD", ["public/app.js"])).toContain(
      `${SHA} HEAD -- . ':(exclude,literal)public/app.js' >`,
    );
    expect(() => patchCommand(SHA, "HEAD", ["public/a b.js"])).toThrow();
    expect(() => patchCommand(SHA, "HEAD", ["x'; rm -rf /"])).toThrow();
    expect(() => patchCommand(SHA, "HEAD", ["../etc/passwd"])).toThrow();
  });
});

describe("splitPatch", () => {
  it("splits per file with status, counts inside hunks only, and rename paths", () => {
    const files = splitPatch(PATCH);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions, f.oldPath])).toEqual([
      ["src/cart.ts", "modified", 2, 1, null],
      ["src/wishlist.ts", "added", 2, 0, null],
      ["old.ts", "deleted", 0, 1, null],
      ["docs/b.md", "renamed", 0, 0, "docs/a.md"],
      ["logo.png", "modified", 0, 0, null],
    ]);
    expect(files[4]?.binary).toBe(true);
    expect(files[0]?.patch.startsWith("@@ -1,3 +1,4 @@")).toBe(true);
    expect(files.every((f) => !f.truncated)).toBe(true);
  });

  it("marks the file the truncation fell in", () => {
    const cut = boundPatch(`${PATCH.length * 10}\n${PATCH}`, 300);
    const files = splitPatch(cut.patch, cut.truncated);
    expect(files.at(-1)?.truncated).toBe(true);
    expect(files.slice(0, -1).every((f) => !f.truncated)).toBe(true);
  });

  it("returns no files for an empty patch", () => {
    expect(splitPatch("")).toEqual([]);
  });
});
