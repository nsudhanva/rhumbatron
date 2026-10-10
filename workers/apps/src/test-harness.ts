/** Literal JavaScript is stable through Wrangler minification and keepNames helpers. */

type Callback = () => unknown;
type Matchers = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toContain(expected: unknown): void;
  toThrow(expected?: string | RegExp | Error | (new (...args: never[]) => Error)): void;
  toHaveLength(expected: number): void;
  toBeNull(): void;
  toBeDefined(): void;
};
export type TestHarness = {
  describe(name: string, callback: Callback): void;
  test(name: string, callback: Callback, ...options: unknown[]): void;
  it(name: string, callback: Callback, ...options: unknown[]): void;
  expect(actual: unknown): Matchers & { not: Matchers };
  beforeEach(callback: Callback): void;
  afterEach(callback: Callback): void;
  runTests(): Promise<{
    passed: number;
    failed: number;
    failures: { name: string; message: string }[];
    unsupported: string[];
  }>;
};

const HARNESS_SOURCE = `function createTestHarness() {
  const root = { name: "", parent: null, before: [], after: [] };
  let suite = root;
  let running = false;
  const tests = [];
  const unsupported = [];
  const message = (error) => String(error).slice(0, 1000);
  function gap(reason) {
    unsupported.push(reason);
    throw new Error(\`Unsupported bun:test API: \${reason}\`);
  }
  function registering() {
    if (running)
      gap("registration during execution");
  }
  function plain(value) {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }
  function equal(a, b, seen = new Map) {
    if (Object.is(a, b))
      return true;
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null)
      return false;
    if (a instanceof Date || b instanceof Date)
      return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
    if (a instanceof RegExp || b instanceof RegExp)
      return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
    if (Array.isArray(a) !== Array.isArray(b))
      return false;
    if (!Array.isArray(a) && (!plain(a) || !plain(b)))
      gap("toEqual supports plain objects, arrays, dates and regexes");
    if (Array.isArray(a) && a.length !== b.length)
      return false;
    if (seen.get(a)?.has(b))
      return true;
    seen.set(a, new Set([...seen.get(a) ?? [], b]));
    const keys = Reflect.ownKeys(a).filter((key) => Object.prototype.propertyIsEnumerable.call(a, key));
    const other = Reflect.ownKeys(b).filter((key) => Object.prototype.propertyIsEnumerable.call(b, key));
    return keys.length === other.length && keys.every((key) => other.includes(key) && equal(Reflect.get(a, key), Reflect.get(b, key), seen));
  }
  function expect(actual, negate = false) {
    function assert(ok, name) {
      if (ok === negate)
        throw new Error(\`Expected \${message(actual)} \${negate ? "not " : ""}\${name}\`);
    }
    const matchers = {
      toBe(expected) {
        assert(Object.is(actual, expected), \`toBe \${message(expected)}\`);
      },
      toEqual(expected) {
        assert(equal(actual, expected), \`toEqual \${message(expected)}\`);
      },
      toBeTruthy() {
        assert(Boolean(actual), "toBeTruthy");
      },
      toBeFalsy() {
        assert(!actual, "toBeFalsy");
      },
      toContain(expected) {
        if (typeof actual !== "string" && !Array.isArray(actual))
          throw new Error("toContain needs a string or array");
        assert(typeof actual === "string" ? typeof expected === "string" && actual.includes(expected) : actual.includes(expected), \`toContain \${message(expected)}\`);
      },
      toThrow(expected) {
        if (typeof actual !== "function")
          throw new Error("toThrow needs a function");
        let thrown = false;
        let error;
        try {
          const returned = actual();
          if (returned && typeof returned.then === "function") {
            Promise.resolve(returned).catch(() => {
              return;
            });
            gap("async toThrow; use a synchronous function");
          }
        } catch (caught) {
          thrown = true;
          error = caught;
        }
        const text = error instanceof Error ? error.message : String(error);
        const matches = expected === undefined || (typeof expected === "string" ? text.includes(expected) : expected instanceof RegExp ? new RegExp(expected.source, expected.flags).test(text) : expected instanceof Error ? text === expected.message : error instanceof expected);
        assert(thrown && matches, "toThrow");
      },
      toHaveLength(expected) {
        if (actual === null || actual === undefined || typeof actual.length !== "number")
          throw new Error("toHaveLength needs a length");
        assert(actual.length === expected, \`toHaveLength \${expected}\`);
      },
      toBeNull() {
        assert(actual === null, "toBeNull");
      },
      toBeDefined() {
        assert(actual !== undefined, "toBeDefined");
      }
    };
    return new Proxy(matchers, {
      get(target, property) {
        if (property === "not")
          return expect(actual, !negate);
        if (typeof property === "string" && Object.hasOwn(target, property))
          return Reflect.get(target, property);
        return gap(\`expect.\${String(property)}\`);
      }
    });
  }
  function bounded(fn, name) {
    return new Proxy(fn, { get: (_target, property) => gap(\`\${name}.\${String(property)}\`) });
  }
  const describe = bounded((name, callback) => {
    registering();
    const parent = suite;
    suite = { name, parent, before: [], after: [] };
    try {
      const result = callback();
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(() => {
          return;
        });
        gap("async describe");
      }
    } finally {
      suite = parent;
    }
  }, "describe");
  const test = bounded((name, callback, ...options) => {
    registering();
    if (typeof callback !== "function" || callback.length > 0 || options.length)
      gap("test options or missing callback");
    if (tests.length >= 1000)
      gap("more than 1000 tests in one file");
    const names = [name];
    for (let scope = suite;scope; scope = scope.parent)
      if (scope.name)
        names.unshift(scope.name);
    tests.push({ name: names.join(" > "), callback, suite });
  }, "test");
  const hook = (list, callback) => {
    registering();
    if (typeof callback !== "function")
      gap("missing hook callback");
    suite[list].push(callback);
  };
  async function runTests() {
    running = true;
    let passed = 0;
    let failed = 0;
    const failures = [];
    for (const item of tests) {
      const scopes = [];
      for (let scope = item.suite;scope; scope = scope.parent)
        scopes.unshift(scope);
      const errors = [];
      try {
        for (const scope of scopes)
          for (const callback of scope.before)
            await callback();
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
      } else
        passed++;
    }
    return { passed, failed, failures, unsupported: [...unsupported] };
  }
  return {
    describe,
    test,
    it: test,
    expect,
    beforeEach: (callback) => hook("before", callback),
    afterEach: (callback) => hook("after", callback),
    runTests
  };
}

const harness = createTestHarness();
export const { describe, test, it, expect, beforeEach, afterEach, runTests } = harness;
`;

export const testHarnessSource = () => HARNESS_SOURCE;
