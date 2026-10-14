// Agent file tools: an edit changes exactly what it names or nothing at all, and a long file is
// read from its start in windows that say where it continues.
import { describe, expect, it } from "vitest";
import { applyEdits, fileWindow } from "./task-tools.ts";

describe("edit_file", () => {
  const text = "const a = 1;\nconst b = 2;\nconst a2 = 1;\n";

  it("applies exact edits in order", () => {
    expect(
      applyEdits(text, [
        { oldText: "const b = 2;", newText: "const b = 3;" },
        { oldText: "const b = 3;\n", newText: "const b = 3;\nconst c = 4;\n" },
      ]),
    ).toEqual({ ok: true, text: "const a = 1;\nconst b = 3;\nconst c = 4;\nconst a2 = 1;\n" });
  });

  it("changes nothing when an oldText is missing or not unique", () => {
    expect(applyEdits(text, [{ oldText: "const z", newText: "x" }])).toMatchObject({
      ok: false,
      error: expect.stringContaining("Edit 1: oldText was not found"),
    });
    expect(
      applyEdits(text, [
        { oldText: "const b = 2;", newText: "const b = 3;" },
        { oldText: " = 1;", newText: " = 9;" },
      ]),
    ).toMatchObject({ ok: false, error: expect.stringContaining("Edit 2: oldText occurs more") });
  });
});

describe("read_file windows", () => {
  const long = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");

  it("returns a short file whole", () => {
    expect(fileWindow("a\nb")).toBe("a\nb");
  });

  it("keeps the start of a long file and says where it continues", () => {
    const first = fileWindow(long, 1, 60);
    expect(first.startsWith("line 1\n")).toBe(true);
    expect(first).toContain("call read_file with fromLine 9");
    const next = fileWindow(long, 9, 60);
    expect(next).toContain("call read_file with fromLine 16");
    expect(next.startsWith("(lines 9 to 15 of 100)\nline 9\n")).toBe(true);
    expect(fileWindow(long, 101)).toBe("The file has 100 lines.");
  });
});
