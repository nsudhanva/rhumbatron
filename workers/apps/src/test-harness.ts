/** Self-contained factory: its compiled function is also the Dynamic Worker harness source. */
export function createTestHarness() {
  type Callback = () => unknown;
  type Suite = { name: string; parent: Suite | null; before: Callback[]; after: Callback[] };
  const root: Suite = { name: "", parent: null, before: [], after: [] };
  let suite = root;
  let running = false;
  const tests: { name: string; callback: Callback; suite: Suite }[] = [];
  const unsupported: string[] = [];
  const message = (error: unknown) => String(error).slice(0, 1000);
  function gap(reason: string): never {
    unsupported.push(reason);
    throw new Error(`Unsupported bun:test API: ${reason}`);
  }
  function registering() {
    if (running) gap("registration during execution");
  }
  function plain(value: object) {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }
  function equal(a: unknown, b: unknown, seen = new Map<object, Set<object>>()): boolean {
    if (Object.is(a, b)) return true;
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
    if (a instanceof Date || b instanceof Date)
      return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
    if (a instanceof RegExp || b instanceof RegExp)
      return (
        a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags
      );
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (!Array.isArray(a) && (!plain(a) || !plain(b)))
      gap("toEqual supports plain objects, arrays, dates and regexes");
    if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false;
    if (seen.get(a)?.has(b)) return true;
    seen.set(a, new Set([...(seen.get(a) ?? []), b]));
    const keys = Reflect.ownKeys(a).filter((key) =>
      Object.prototype.propertyIsEnumerable.call(a, key),
    );
    const other = Reflect.ownKeys(b).filter((key) =>
      Object.prototype.propertyIsEnumerable.call(b, key),
    );
    return (
      keys.length === other.length &&
      keys.every(
        (key) => other.includes(key) && equal(Reflect.get(a, key), Reflect.get(b, key), seen),
      )
    );
  }
  function expect(actual: unknown, negate = false) {
    function assert(ok: boolean, name: string) {
      if (ok === negate)
        throw new Error(`Expected ${message(actual)} ${negate ? "not " : ""}${name}`);
    }
    const matchers = {
      toBe(expected: unknown) {
        assert(Object.is(actual, expected), `toBe ${message(expected)}`);
      },
      toEqual(expected: unknown) {
        assert(equal(actual, expected), `toEqual ${message(expected)}`);
      },
      toBeTruthy() {
        assert(Boolean(actual), "toBeTruthy");
      },
      toBeFalsy() {
        assert(!actual, "toBeFalsy");
      },
      toContain(expected: unknown) {
        if (typeof actual !== "string" && !Array.isArray(actual))
          throw new Error("toContain needs a string or array");
        assert(
          typeof actual === "string"
            ? typeof expected === "string" && actual.includes(expected)
            : actual.includes(expected),
          `toContain ${message(expected)}`,
        );
      },
      toThrow(expected?: string | RegExp | Error | (new (...args: never[]) => Error)) {
        if (typeof actual !== "function") throw new Error("toThrow needs a function");
        let thrown = false;
        let error: unknown;
        try {
          const returned = actual();
          if (returned && typeof returned.then === "function") {
            void Promise.resolve(returned).catch(() => undefined);
            gap("async toThrow; use a synchronous function");
          }
        } catch (caught) {
          thrown = true;
          error = caught;
        }
        const text = error instanceof Error ? error.message : String(error);
        const matches =
          expected === undefined ||
          (typeof expected === "string"
            ? text.includes(expected)
            : expected instanceof RegExp
              ? new RegExp(expected.source, expected.flags).test(text)
              : expected instanceof Error
                ? text === expected.message
                : error instanceof expected);
        assert(thrown && matches, "toThrow");
      },
      toHaveLength(expected: number) {
        if (
          actual === null ||
          actual === undefined ||
          typeof (actual as { length?: unknown }).length !== "number"
        )
          throw new Error("toHaveLength needs a length");
        assert((actual as { length: number }).length === expected, `toHaveLength ${expected}`);
      },
      toBeNull() {
        assert(actual === null, "toBeNull");
      },
      toBeDefined() {
        assert(actual !== undefined, "toBeDefined");
      },
    };
    return new Proxy(matchers, {
      get(target, property) {
        if (property === "not") return expect(actual, !negate);
        if (typeof property === "string" && Object.hasOwn(target, property))
          return Reflect.get(target, property);
        return gap(`expect.${String(property)}`);
      },
    }) as typeof matchers & { not: typeof matchers };
  }
  function bounded<T extends (...args: never[]) => unknown>(fn: T, name: string): T {
    return new Proxy(fn, { get: (_target, property) => gap(`${name}.${String(property)}`) });
  }
  const describe = bounded((name: string, callback: Callback) => {
    registering();
    const parent = suite;
    suite = { name, parent, before: [], after: [] };
    try {
      const result = callback();
      if (result && typeof (result as Promise<unknown>).then === "function") {
        void Promise.resolve(result).catch(() => undefined);
        gap("async describe");
      }
    } finally {
      suite = parent;
    }
  }, "describe");
  const test = bounded((name: string, callback: Callback, ...options: unknown[]) => {
    registering();
    if (typeof callback !== "function" || callback.length > 0 || options.length)
      gap("test options or missing callback");
    if (tests.length >= 1000) gap("more than 1000 tests in one file");
    const names: string[] = [name];
    for (let scope: Suite | null = suite; scope; scope = scope.parent)
      if (scope.name) names.unshift(scope.name);
    tests.push({ name: names.join(" > "), callback, suite });
  }, "test");
  const hook = (list: "before" | "after", callback: Callback) => {
    registering();
    if (typeof callback !== "function") gap("missing hook callback");
    suite[list].push(callback);
  };
  async function runTests() {
    running = true;
    let passed = 0;
    let failed = 0;
    const failures: { name: string; message: string }[] = [];
    for (const item of tests) {
      const scopes: Suite[] = [];
      for (let scope: Suite | null = item.suite; scope; scope = scope.parent) scopes.unshift(scope);
      const errors: string[] = [];
      try {
        for (const scope of scopes) for (const callback of scope.before) await callback();
        await item.callback();
      } catch (error) {
        errors.push(message(error));
      } finally {
        for (const scope of [...scopes].reverse())
          for (const callback of scope.after) {
            try {
              await callback();
            } catch (error) {
              errors.push(message(error));
            }
          }
      }
      if (errors.length) {
        failed++;
        failures.push({ name: item.name.slice(0, 300), message: errors.join("; ").slice(0, 1000) });
      } else passed++;
    }
    return { passed, failed, failures, unsupported: [...unsupported] };
  }
  return {
    describe,
    test,
    it: test,
    expect,
    beforeEach: (callback: Callback) => hook("before", callback),
    afterEach: (callback: Callback) => hook("after", callback),
    runTests,
  };
}

/** Do not move helpers outside the factory: this source must have no host closure. */
export const testHarnessSource = () => `
const harness = (${createTestHarness.toString()})();
export const { describe, test, it, expect, beforeEach, afterEach, runTests } = harness;
`;
