import { isAppBuildInput } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import {
  AppBundle,
  bundleKey,
  decodeModules,
  encodeModules,
  findRealAuth,
  readAppSettings,
} from "./bundle.ts";

const P = "proj_1111";
const C = "c".repeat(40);

describe("bundle keys", () => {
  it("content-addresses bundles by Project and commit; previews use their own prefix", () => {
    expect(bundleKey("production", P, C)).toBe(`apps/${P}/${C}`);
    expect(bundleKey("preview", P, C)).toBe(`app-previews/${P}/${C}`);
  });

  it("rejects ids that could escape the prefix", () => {
    expect(() => bundleKey("production", "proj_../x", C)).toThrow();
    expect(() => bundleKey("production", P, "main")).toThrow();
  });
});

describe("bundle manifest", () => {
  it("round-trips text and binary modules through JSON", () => {
    const data = new Uint8Array([0, 1, 2, 255]).buffer;
    const stored = encodeModules({ "index.js": "export default {}", "x.bin": { data } });
    const json = JSON.parse(JSON.stringify(stored));
    const decoded = decodeModules(json);
    expect(decoded["index.js"]).toBe("export default {}");
    expect(new Uint8Array((decoded["x.bin"] as { data: ArrayBuffer }).data)).toEqual(
      new Uint8Array([0, 1, 2, 255]),
    );
  });

  it("validates a stored bundle and rejects unknown module shapes", () => {
    const bundle = {
      version: 1,
      projectId: P,
      commit: C,
      treeSha: "t",
      mainModule: "index.js",
      modules: { "index.js": "export default {}" },
      compatibilityDate: "2026-10-08",
      compatibilityFlags: ["nodejs_compat"],
      assets: [{ path: "/index.html", contentType: "text/html", etag: "e", size: 10 }],
      assetConfig: { notFoundHandling: "none", runWorkerFirst: false },
      builder: "worker-bundler@0.2.6",
      builtAt: "2026-10-10T00:00:00.000Z",
    };
    expect(AppBundle.parse(bundle)).toEqual(bundle);
    expect(() =>
      AppBundle.parse({ ...bundle, modules: { "index.js": { py: "print(1)" } } }),
    ).toThrow();
  });

  it("reads the Acme wrangler.jsonc: assets directory, compat date, allowed flags only", () => {
    const settings = readAppSettings({
      "wrangler.jsonc": `// comment "with quotes"
{
  "name": "x", // trailing
  "main": "src/worker.ts",
  "compatibility_date": "2026-10-08",
  "compatibility_flags": ["nodejs_compat", "experimental"],
  /* block */
  "assets": { "directory": "./public/", "not_found_handling": "none" },
}`,
    });
    expect(settings).toEqual({
      assetsDirectory: "public",
      notFoundHandling: "none",
      runWorkerFirst: false,
      compatibilityDate: "2026-10-08",
      compatibilityFlags: ["nodejs_compat"],
    });
  });

  it("leaves tests, benches, lockfiles, and docs out of the build", () => {
    expect(isAppBuildInput("src/app.ts")).toBe(true);
    expect(isAppBuildInput("public/index.html")).toBe(true);
    for (const path of [
      "test/cart.test.ts",
      "bench/x.ts",
      "src/a.test.ts",
      "bun.lock",
      "README.md",
    ]) {
      expect(isAppBuildInput(path)).toBe(false);
    }
  });
});

describe("real auth check", () => {
  it("passes the fake identity of the Acme template", () => {
    expect(
      findRealAuth({
        "package.json": JSON.stringify({ dependencies: { hono: "4.13.13" } }),
        "src/identity.ts": 'export const FIXTURE_USERS = ["alice", "bob"] as const;',
        "public/index.html": '<select name="user"><option>alice</option></select>',
      }),
    ).toEqual([]);
  });

  it("flags auth SDKs in package.json and imports, and password fields", () => {
    const findings = findRealAuth({
      "package.json": JSON.stringify({ dependencies: { "@clerk/backend": "1", bcryptjs: "2" } }),
      "src/a.ts": 'import NextAuth from "next-auth";\nconst f = await import("firebase/auth");',
      "public/login.html": '<input type="password" name="pw">',
      "src/form.tsx": "<input type={'password'} />",
    });
    expect(findings.map((f) => f.path).sort()).toEqual([
      "package.json",
      "package.json",
      "public/login.html",
      "src/a.ts",
      "src/a.ts",
      "src/form.tsx",
    ]);
  });
});
