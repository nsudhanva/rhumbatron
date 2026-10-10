import { describe, expect, it } from "vitest";
import { createTestHarness, testHarnessSource } from "./test-harness.ts";

describe("check harness assertions", () => {
  it("accepts every supported assertion and rejects incorrect values", () => {
    const h = createTestHarness();
    const cases: [() => void, () => void][] = [
      [() => h.expect(NaN).toBe(NaN), () => h.expect({}).toBe({})],
      [
        () => h.expect({ b: [2], a: 1 }).toEqual({ a: 1, b: [2] }),
        () => h.expect({ a: 1 }).toEqual({ a: 2 }),
      ],
      [() => h.expect("yes").toBeTruthy(), () => h.expect(0).toBeTruthy()],
      [() => h.expect(0).toBeFalsy(), () => h.expect(1).toBeFalsy()],
      [() => h.expect([1, 2]).toContain(2), () => h.expect([1, 2]).toContain(3)],
      [() => h.expect("abc").toContain("b"), () => h.expect("abc").toContain("d")],
      [
        () =>
          h
            .expect(() => {
              throw new Error("boom");
            })
            .toThrow(/boom/),
        () => h.expect(() => undefined).toThrow(),
      ],
      [() => h.expect([1, 2]).toHaveLength(2), () => h.expect([1]).toHaveLength(2)],
      [() => h.expect(null).toBeNull(), () => h.expect(undefined).toBeNull()],
      [() => h.expect(null).toBeDefined(), () => h.expect(undefined).toBeDefined()],
      [() => h.expect(1).not.toBe(2), () => h.expect(1).not.toBe(1)],
    ];
    for (const [pass, fail] of cases) {
      expect(pass).not.toThrow();
      expect(fail).toThrow();
    }
  });

  it("compares objects without JSON key order or undefined/NaN coercion", () => {
    const h = createTestHarness();
    expect(() => h.expect({ a: undefined }).toEqual({})).toThrow();
    expect(() => h.expect([NaN]).toEqual([null])).toThrow();
    expect(() => h.expect([undefined]).toEqual([null])).toThrow();
    expect(() => h.expect(new Date(1)).toEqual(new Date(2))).toThrow();
    expect(() => h.expect(/x/).toEqual(/y/)).toThrow();
    const a: { self?: unknown } = {};
    a.self = a;
    const b: { self?: unknown } = {};
    b.self = b;
    expect(() => h.expect(a).toEqual(b)).not.toThrow();
    expect(() => h.expect([1, 2]).toEqual([1])).toThrow();
  });

  it("matches thrown strings, messages and error classes, including thrown undefined", () => {
    const h = createTestHarness();
    h.expect(() => {
      throw undefined;
    }).toThrow();
    h.expect(() => {
      throw new TypeError("bad input");
    }).toThrow(TypeError);
    h.expect(() => {
      throw new Error("bad input");
    }).toThrow("input");
    h.expect(() => {
      throw new Error("bad input");
    }).toThrow(new Error("bad input"));
    expect(() =>
      h
        .expect(() => {
          throw new Error("bad");
        })
        .toThrow(TypeError),
    ).toThrow();
    expect(() => h.expect(42).toThrow()).toThrow();
    expect(() => h.expect(null).toHaveLength(0)).toThrow();
    expect(() => h.expect(42).toContain(2)).toThrow();
  });
});

describe("harness execution", () => {
  it("awaits tests and scoped hooks, including hooks declared after a test", async () => {
    const h = createTestHarness();
    const calls: string[] = [];
    h.beforeEach(async () => {
      calls.push("root before");
    });
    h.afterEach(() => {
      calls.push("root after");
    });
    h.describe("outer", () => {
      h.test("first", async () => {
        await Promise.resolve();
        calls.push("first");
      });
      h.beforeEach(() => {
        calls.push("outer before");
      });
      h.afterEach(() => {
        calls.push("outer after");
      });
      h.describe("inner", () => {
        h.beforeEach(() => {
          calls.push("inner before");
        });
        h.afterEach(() => {
          calls.push("inner after");
        });
        h.it("second", () => {
          calls.push("second");
        });
      });
    });
    h.test("sibling", () => {
      calls.push("sibling");
    });
    const report = await h.runTests();
    expect(report).toEqual({ passed: 3, failed: 0, failures: [], unsupported: [] });
    expect(calls).toEqual([
      "root before",
      "outer before",
      "first",
      "outer after",
      "root after",
      "root before",
      "outer before",
      "inner before",
      "second",
      "inner after",
      "outer after",
      "root after",
      "root before",
      "sibling",
      "root after",
    ]);
  });

  it("counts a hook or assertion failure once and always runs cleanup", async () => {
    const h = createTestHarness();
    const calls: string[] = [];
    h.describe("bad setup", () => {
      h.beforeEach(() => {
        throw new Error("setup");
      });
      h.afterEach(() => {
        calls.push("cleanup");
        throw new Error("cleanup failure");
      });
      h.test("does not run", () => {
        calls.push("body");
      });
    });
    h.test("bad assertion", () => h.expect(1).toBe(2));
    h.test("continues", () => h.expect(true).toBeTruthy());
    const report = await h.runTests();
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(2);
    expect(report.failures[0]).toEqual({
      name: "bad setup > does not run",
      message: "Error: setup; Error: cleanup failure",
    });
    expect(calls).toEqual(["cleanup"]);
  });

  it("records unsupported APIs even when app code catches the exception", async () => {
    const h = createTestHarness();
    h.test("unsupported matcher", () => {
      try {
        Reflect.get(h.expect(1), "toBeGreaterThan")(0);
      } catch {}
    });
    try {
      Reflect.get(h.test, "skip")("skipped", () => {});
    } catch {}
    h.test("unsupported equality", () => {
      try {
        h.expect(new Set([1])).toEqual(new Set([2]));
      } catch {}
    });
    h.test("async throw", () =>
      h
        .expect(async () => {
          throw new Error("async");
        })
        .toThrow(),
    );
    const report = await h.runTests();
    expect(report.unsupported).toHaveLength(4);
  });

  it("does not report empty files as executed tests", async () => {
    expect(await createTestHarness().runTests()).toEqual({
      passed: 0,
      failed: 0,
      failures: [],
      unsupported: [],
    });
  });

  it("emits executable JavaScript without a host closure", async () => {
    const source = testHarnessSource().replace("export const", "const");
    const h = new Function(`${source}\nreturn harness;`)() as ReturnType<typeof createTestHarness>;
    h.test("generated", () => h.expect({ a: [1] }).toEqual({ a: [1] }));
    expect((await h.runTests()).passed).toBe(1);
  });
});
