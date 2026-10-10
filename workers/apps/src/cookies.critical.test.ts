import { describe, expect, it } from "vitest";
import {
  appRequestCookies,
  appRequestHeaders,
  appResponseHeaders,
  appSetCookie,
} from "./cookies.ts";

describe("appRequestCookies", () => {
  it("passes only the app's own (prefixed) cookies, unprefixed", () => {
    expect(
      appRequestCookies("__client_uat=1791607709; rba_user=bob; __session=jwt; rba_cart=a=b"),
    ).toBe("user=bob; cart=a=b");
  });

  it("returns null when no app cookie is present", () => {
    expect(appRequestCookies("__session=jwt; __client_uat=0")).toBeNull();
    expect(appRequestCookies(null)).toBeNull();
    expect(appRequestCookies("rba_=x; =y; junk")).toBeNull();
  });
});

describe("appSetCookie", () => {
  it("prefixes the name and keeps the attributes", () => {
    expect(appSetCookie("user=bob; Path=/; HttpOnly; SameSite=Lax")).toBe(
      "rba_user=bob; Path=/; HttpOnly; SameSite=Lax",
    );
  });

  it("drops any cookie with a Domain attribute, whatever its value", () => {
    expect(appSetCookie("__session=evil; Domain=rhumbatron.com; Path=/")).toBeNull();
    expect(appSetCookie("x=1; domain=.rhumbatron.com")).toBeNull();
    expect(appSetCookie("x=1; DOMAIN=acme.rhumbatron.com")).toBeNull();
  });

  it("drops malformed cookies", () => {
    expect(appSetCookie("novalue")).toBeNull();
    expect(appSetCookie("=x")).toBeNull();
    expect(appSetCookie("bad name=x")).toBeNull();
  });
});

describe("header rewriting", () => {
  it("removes the Cookie header when nothing is left, and Access assertions always", () => {
    const out = appRequestHeaders(
      new Headers({ cookie: "__session=jwt", "cf-access-jwt-assertion": "x", accept: "*/*" }),
    );
    expect(out.has("cookie")).toBe(false);
    expect(out.has("cf-access-jwt-assertion")).toBe(false);
    expect(out.get("accept")).toBe("*/*");
  });

  it("rewrites every Set-Cookie and drops the Domain ones", () => {
    const headers = new Headers();
    headers.append("set-cookie", "user=bob; Path=/");
    headers.append("set-cookie", "__session=evil; Domain=rhumbatron.com");
    headers.append("content-type", "text/html");
    const out = appResponseHeaders(headers);
    expect(out.getSetCookie()).toEqual(["rba_user=bob; Path=/"]);
    expect(out.get("content-type")).toBe("text/html");
  });
});
