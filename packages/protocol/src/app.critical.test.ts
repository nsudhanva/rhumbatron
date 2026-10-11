import { describe, expect, it } from "vitest";
import { appLabelCandidates, appUrl, parseAppHost, previewIdFor } from "./app.ts";

const D = "rhumbatron.com";

describe("parseAppHost", () => {
  it("maps a one-label host to the production app", () => {
    expect(parseAppHost("acme.rhumbatron.com", D)).toEqual({ kind: "production", label: "acme" });
    expect(parseAppHost("Acme-Shop.RHUMBATRON.com.:443", D)).toEqual({
      kind: "production",
      label: "acme-shop",
    });
  });

  it("maps <preview-id>--<label> to a preview", () => {
    expect(parseAppHost("a1b2c3d4--acme-shop.rhumbatron.com", D)).toEqual({
      kind: "preview",
      label: "acme-shop",
      previewId: "a1b2c3d4",
    });
  });

  it("reserves Rhumbatron and Clerk hosts, also as preview targets", () => {
    for (const label of ["www", "api", "clerk", "accounts", "clkmail"]) {
      expect(parseAppHost(`${label}.rhumbatron.com`, D)).toEqual({ kind: "reserved", label });
    }
    expect(parseAppHost("rhumbatron-x.rhumbatron.com", D).kind).toBe("reserved");
    expect(parseAppHost("a1b2c3d4--api.rhumbatron.com", D).kind).toBe("reserved");
  });

  it("rejects the apex, deeper names, other zones, and malformed labels", () => {
    for (const host of [
      "rhumbatron.com",
      "x.acme.rhumbatron.com",
      "clk._domainkey.rhumbatron.com",
      "acme.rhumbatron.com.evil.com",
      "acmerhumbatron.com",
      "-acme.rhumbatron.com",
      "acme-.rhumbatron.com",
      "a1b2--acme.rhumbatron.com",
      "a1b2c3d4--.rhumbatron.com",
      "a1b2c3d4--x--y.rhumbatron.com",
      "xn--80ak6aa92e.rhumbatron.com",
      `${"a".repeat(51)}.rhumbatron.com`,
    ]) {
      expect(parseAppHost(host, D)).toEqual({ kind: "invalid" });
    }
  });
});

describe("appLabelCandidates", () => {
  it("uses the slug first and a Project-ID suffix second", () => {
    expect(appLabelCandidates("acme-shop", "proj_3f9a1c2e-1111")).toEqual([
      "acme-shop",
      "acme-shop-3f9a1c",
    ]);
  });

  it("never yields a reserved, double-hyphen, or over-long label", () => {
    const [first] = appLabelCandidates("api", "proj_abc");
    expect(first).toBe("api-app");
    const [long, fallback] = appLabelCandidates("a".repeat(64), "proj_abcdef12");
    expect(long.length).toBeLessThanOrEqual(50);
    expect(fallback.length).toBeLessThanOrEqual(50);
    for (const label of [first, long, fallback]) {
      expect(parseAppHost(`${label}.rhumbatron.com`, D).kind).toBe("production");
    }
  });

  it("builds preview hosts that parse back", () => {
    const previewId = previewIdFor("cand_0123456789abcdef01234567");
    expect(previewId).toBe("01234567");
    const host = appUrl(D, "acme-shop", previewId).replace("https://", "");
    expect(parseAppHost(host, D)).toEqual({ kind: "preview", label: "acme-shop", previewId });
  });
});
