import { describe, expect, it } from "vitest";
import { allowedTarget, parseAllowlist, parseProxyHead } from "./egress-policy.ts";

const allow = parseAllowlist("registry.npmjs.org:443,git:8080");
const target = (head: string) => {
  const p = parseProxyHead(head);
  return p ? allowedTarget(allow, p.host, p.port) : null;
};

describe("egress allowlist", () => {
  it("opens only allowlisted host:port pairs", () => {
    expect(target("CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n")).toBe(true);
    expect(target("CONNECT REGISTRY.npmjs.org:443 HTTP/1.1\r\n\r\n")).toBe(true);
    expect(target("CONNECT registry.npmjs.org:22 HTTP/1.1\r\n\r\n")).toBe(false);
    expect(target("CONNECT example.com:443 HTTP/1.1\r\n\r\n")).toBe(false);
    expect(target("CONNECT registry.npmjs.org.evil.com:443 HTTP/1.1\r\n\r\n")).toBe(false);
    expect(target("GET http://git:8080/repo.git/info/refs HTTP/1.1\r\nHost: git\r\n\r\n")).toBe(
      true,
    );
    expect(target("GET http://git/ HTTP/1.1\r\n\r\n")).toBe(false);
  });

  it("rejects requests that are not CONNECT or absolute-form HTTP", () => {
    expect(target("GET / HTTP/1.1\r\nHost: git:8080\r\n\r\n")).toBeNull();
    expect(target("GET https://registry.npmjs.org/ HTTP/1.1\r\n\r\n")).toBeNull();
    expect(target("GET http://u:p@git:8080/ HTTP/1.1\r\n\r\n")).toBeNull();
    expect(target("CONNECT [::1]:443 HTTP/1.1\r\n\r\n")).toBeNull();
  });
});
