// Code page edit sessions (ADR 0029): the expiry decision and the path and content limits.
import { describe, expect, it } from "vitest";
import { MAX_EDIT_BYTES, normalizeEditPath } from "./code-edit.ts";
import {
  CODE_SESSION_IDLE_MS,
  CODE_SESSION_MAX_MS,
  contentRefusal,
  normalizeCwd,
  sessionExpiry,
} from "./code-session.ts";

const T0 = Date.parse("2026-10-11T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("session expiry", () => {
  const session = (lastUsed: number) => ({
    lastUsedAt: iso(lastUsed),
    hardExpiresAt: iso(T0 + CODE_SESSION_MAX_MS),
  });

  it("keeps a session open until 10 idle minutes and reports when it ends", () => {
    expect(sessionExpiry(session(T0), T0 + CODE_SESSION_IDLE_MS - 1)).toEqual({
      expired: false,
      expiresAt: iso(T0 + CODE_SESSION_IDLE_MS),
    });
  });

  it("ends a session at exactly 10 idle minutes: a late request never revives it", () => {
    expect(sessionExpiry(session(T0), T0 + CODE_SESSION_IDLE_MS)).toEqual({
      expired: true,
      reason: "idle",
    });
  });

  it("ends a used session at 2 hours, and the countdown never passes the 2-hour limit", () => {
    const busy = session(T0 + CODE_SESSION_MAX_MS - 60_000);
    const before = sessionExpiry(busy, T0 + CODE_SESSION_MAX_MS - 1);
    expect(before).toEqual({ expired: false, expiresAt: iso(T0 + CODE_SESSION_MAX_MS) });
    expect(sessionExpiry(busy, T0 + CODE_SESSION_MAX_MS)).toEqual({
      expired: true,
      reason: "max_age",
    });
  });

  it("treats unreadable timestamps as expired, never as open", () => {
    expect(sessionExpiry({ lastUsedAt: "x", hardExpiresAt: "y" }, T0)).toMatchObject({
      expired: true,
    });
  });
});

describe("session paths and content", () => {
  it("accepts repository paths and refuses escapes, absolute paths, and .git", () => {
    expect(normalizeEditPath("src/app.ts")).toBe("src/app.ts");
    expect(normalizeEditPath("./src/app.ts")).toBe("src/app.ts");
    for (const bad of [
      "../etc/passwd",
      "src/../../x",
      "/etc/passwd",
      ".git/config",
      ".git",
      "src/.git/hooks/pre-commit",
      ".GIT/config",
      "src\\app.ts",
      "src//app.ts",
      "src/",
      "a\nb",
      "",
    ]) {
      expect(normalizeEditPath(bad)).toBeNull();
    }
  });

  it("accepts the root and folders as a command cwd, never a path outside the checkout", () => {
    expect(normalizeCwd(undefined)).toBe("");
    expect(normalizeCwd(".")).toBe("");
    expect(normalizeCwd("src/")).toBe("src");
    expect(normalizeCwd("..")).toBeNull();
    expect(normalizeCwd("/workspace")).toBeNull();
    expect(normalizeCwd(".git")).toBeNull();
  });

  it("refuses content over 256 KB (UTF-8 bytes) and binary content", () => {
    expect(contentRefusal("a".repeat(MAX_EDIT_BYTES))).toBeNull();
    expect(contentRefusal("a".repeat(MAX_EDIT_BYTES + 1))).toBe("too_large");
    expect(contentRefusal("é".repeat(MAX_EDIT_BYTES / 2 + 1))).toBe("too_large");
    expect(contentRefusal("a\u0000b")).toBe("binary");
  });
});
