import { describe, expect, it } from "vitest";
import { splitPatch } from "./code.ts";
import {
  checkEdit,
  editRefusalStatus,
  humanEditIntent,
  MAX_EDIT_BYTES,
  normalizeEditPath,
  unifiedFilePatch,
} from "./code-edit.ts";

const TREE = "a".repeat(40);
const OTHER = "b".repeat(40);

describe("human edit validation", () => {
  const edit = (content: string, baseTree = TREE, path = "src/catalog.ts") => ({
    path,
    content,
    baseTree,
  });

  it("accepts a text edit on the live tree", () => {
    expect(checkEdit(edit("export const x = 1;\n"), TREE)).toEqual({
      status: "ok",
      path: "src/catalog.ts",
    });
  });

  it("refuses an edit made on an older tree with 409 'the file changed; reload'", () => {
    const outcome = checkEdit(edit("x"), OTHER);
    expect(outcome).toMatchObject({ status: "refused", reason: "stale_base" });
    if (outcome.status === "refused") {
      expect(outcome.detail).toBe("The file changed; reload.");
      expect(editRefusalStatus(outcome.reason)).toBe(409);
    }
  });

  it("refuses a project without canonical source", () => {
    expect(checkEdit(edit("x"), null)).toMatchObject({ reason: "no_source" });
  });

  it("allows exactly 256 KB and refuses one byte more, counting UTF-8 bytes", () => {
    expect(checkEdit(edit("a".repeat(MAX_EDIT_BYTES)), TREE).status).toBe("ok");
    const over = checkEdit(edit("a".repeat(MAX_EDIT_BYTES + 1)), TREE);
    expect(over).toMatchObject({ reason: "too_large" });
    if (over.status === "refused") expect(editRefusalStatus(over.reason)).toBe(413);
    // 2 bytes per "é": half the characters already fill the limit.
    expect(checkEdit(edit("é".repeat(MAX_EDIT_BYTES / 2 + 1)), TREE)).toMatchObject({
      reason: "too_large",
    });
  });

  it("refuses binary content (a NUL byte)", () => {
    expect(checkEdit(edit("abc\u0000def"), TREE)).toMatchObject({ reason: "binary" });
  });

  it("checks size and type before the base tree, so a bad edit never reaches Artifacts", () => {
    expect(checkEdit(edit("\u0000", OTHER), TREE)).toMatchObject({ reason: "binary" });
  });

  it("refuses paths outside the repository or inside .git", () => {
    for (const path of ["../etc/passwd", "/abs.ts", "src/../x.ts", ".git/config", "a\\b", "src/"]) {
      expect(normalizeEditPath(path)).toBeNull();
      expect(checkEdit(edit("x", TREE, path), TREE)).toMatchObject({ reason: "invalid_path" });
    }
    expect(normalizeEditPath("./src/cart.ts")).toBe("src/cart.ts");
  });
});

describe("human ChangeSet intent", () => {
  const app = (extra = "") =>
    `app.get("/api/products", list);\napp.post('/api/cart/items', add);\n${extra}`;

  it("derives resources from the path and the summary from the message", () => {
    const intent = humanEditIntent({
      path: "src/catalog.ts",
      before: "export const title = 'Shop';\n",
      after: "export const title = 'Acme Shop';\n",
      message: "Rename the shop title\n\nlonger body",
      protectedResources: ["cart", "checkout", "identity.auth"],
    });
    expect(intent).toMatchObject({
      summary: "Rename the shop title",
      semanticResources: ["catalog"],
      expectedFiles: ["src/catalog.ts"],
      expectedContractChanges: [],
      riskTier: "low",
      touchesAuthorization: false,
    });
  });

  it("maps nested, test, UI, docs and config paths", () => {
    const resources = (path: string) =>
      humanEditIntent({ path, before: "", after: "x", message: "m" }).semanticResources;
    expect(resources("src/wishlist/membership.ts")).toEqual(["wishlist:membership"]);
    expect(resources("src/wishlist/index.ts")).toEqual(["wishlist"]);
    expect(resources("test/cart.test.ts")).toEqual(["cart"]);
    expect(resources("public/styles.css")).toEqual(["ui"]);
    expect(resources("README.md")).toEqual(["docs"]);
    expect(resources("package.json")).toEqual(["config"]);
  });

  it("declares added and removed routes, and a route change is medium risk", () => {
    const intent = humanEditIntent({
      path: "src/app.ts",
      before: app('app.delete("/api/old", x);'),
      after: app('app.get("/api/wishlists/:id", show);'),
      message: "Add wishlist read",
    });
    expect(intent.expectedContractChanges).toEqual([
      "GET /api/wishlists/:id - added",
      "DELETE /api/old - removed",
    ]);
    expect(intent.riskTier).toBe("medium");
  });

  it("is high risk on a protected resource or an authorization path", () => {
    const protectedResources = ["cart", "checkout", "identity.auth"];
    const tier = (path: string) =>
      humanEditIntent({ path, before: "a", after: "b", message: "m", protectedResources });
    expect(tier("src/cart.ts").riskTier).toBe("high");
    expect(tier("src/identity.ts")).toMatchObject({ riskTier: "high", touchesAuthorization: true });
    expect(tier("migrations/0002_x.sql")).toMatchObject({
      riskTier: "high",
      touchesMigration: true,
    });
  });
});

describe("one-file patch", () => {
  it("is empty when nothing changed", () => {
    expect(unifiedFilePatch({ path: "a.ts", before: "x\n", after: "x\n" }).patch).toBe("");
  });

  it("writes git-style hunks that the Files changed parser reads back", () => {
    const before = `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    const after = before.replace("line 2\n", "line two\n").replace("line 18\n", "");
    const { patch, additions, deletions } = unifiedFilePatch({ path: "src/a.ts", before, after });
    expect({ additions, deletions }).toEqual({ additions: 1, deletions: 2 });
    expect(patch).toContain("@@ -1,5 +1,5 @@");
    expect(patch).toContain("@@ -15,6 +15,5 @@");
    const [file] = splitPatch(patch);
    expect(file).toMatchObject({
      path: "src/a.ts",
      status: "modified",
      additions: 1,
      deletions: 2,
    });
  });

  it("marks a missing final newline", () => {
    const { patch } = unifiedFilePatch({ path: "a.txt", before: "a\nb\n", after: "a\nb" });
    expect(patch).toContain("-b\n+b\n\\ No newline at end of file\n");
  });
});
