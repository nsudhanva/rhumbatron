/** Pure parsing and policy for the egress proxy. */

export type ProxyHead = {
  connect: boolean;
  host: string;
  port: number;
  /** The request head to send upstream (origin-form) for a plain HTTP request. */
  forwardHead: string;
};

/** `host:port` entries, comma-separated. Hosts are lowercase; a port is required. */
export function parseAllowlist(raw: string): Set<string> {
  const out = new Set<string>();
  for (const item of raw.split(",")) {
    const entry = item.trim().toLowerCase();
    if (/^[a-z0-9.-]+:\d{1,5}$/.test(entry)) out.add(entry);
  }
  return out;
}

export const allowedTarget = (allow: Set<string>, host: string, port: number) =>
  allow.has(`${host.toLowerCase()}:${port}`);

const HOST = /^[A-Za-z0-9.-]{1,253}$/;

/** Parses a proxy request head. Null for anything that is not CONNECT or absolute-form HTTP. */
export function parseProxyHead(head: string): ProxyHead | null {
  const lineEnd = head.indexOf("\r\n");
  const [method, target, version] = head.slice(0, lineEnd).split(" ");
  if (!method || !target || !version?.startsWith("HTTP/1.")) return null;
  if (method === "CONNECT") {
    const m = /^([^:/]+):(\d{1,5})$/.exec(target);
    if (!m?.[1] || !HOST.test(m[1])) return null;
    const port = Number(m[2]);
    if (port < 1 || port > 65535) return null;
    return { connect: true, host: m[1], port, forwardHead: "" };
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.username || url.password || !HOST.test(url.hostname)) {
    return null;
  }
  const port = Number(url.port || 80);
  const headers = head
    .slice(lineEnd + 2)
    .split("\r\n")
    .filter((line) => line && !/^proxy-/i.test(line));
  const forwardHead = [
    `${method} ${url.pathname}${url.search} ${version}`,
    ...headers,
    "",
    "",
  ].join("\r\n");
  return { connect: false, host: url.hostname, port, forwardHead };
}
