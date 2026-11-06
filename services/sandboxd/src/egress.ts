import { connect, createServer, type Socket } from "node:net";
import { allowedTarget, parseAllowlist, parseProxyHead } from "./egress-policy.ts";

/**
 * The sandbox egress proxy. Sandboxes sit on an internal network; this proxy is their only way
 * out. It accepts HTTP CONNECT (HTTPS) and absolute-form HTTP requests, and opens a connection
 * only to an allowlisted `host:port`. Every other target gets 403.
 */

const allow = parseAllowlist(
  process.env.EGRESS_ALLOW ??
    "registry.npmjs.org:443,registry.yarnpkg.com:443,bun.sh:443,github.com:443,codeload.github.com:443,objects.githubusercontent.com:443,git:8080",
);
const port = Number(process.env.EGRESS_PORT ?? 4750);
const MAX_HEAD = 16 * 1024;

const log = (event: string, fields: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);

const refuse = (client: Socket, status: string) => {
  client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

const server = createServer((client) => {
  let head = Buffer.alloc(0);
  client.setTimeout(30_000, () => client.destroy());
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) {
      if (head.length > MAX_HEAD) refuse(client, "431 Request Header Fields Too Large");
      return;
    }
    client.off("data", onData);
    client.pause();
    const parsed = parseProxyHead(head.subarray(0, end + 4).toString("latin1"));
    const rest = head.subarray(end + 4);
    if (!parsed) return refuse(client, "400 Bad Request");
    const target = `${parsed.host}:${parsed.port}`;
    if (!allowedTarget(allow, parsed.host, parsed.port)) {
      log("egress.denied", { target });
      return refuse(client, "403 Forbidden");
    }
    const upstream = connect({ host: parsed.host, port: parsed.port });
    upstream.setTimeout(30_000, () => upstream.destroy());
    upstream.once("connect", () => {
      client.setTimeout(0);
      upstream.setTimeout(0);
      log("egress.allowed", { target, connect: parsed.connect });
      if (parsed.connect) client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      else upstream.write(parsed.forwardHead);
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.on("error", () => {
      if (!client.destroyed) refuse(client, "502 Bad Gateway");
    });
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  };
  client.on("data", onData);
  client.on("error", () => client.destroy());
});

server.listen(port, "0.0.0.0", () => log("egress.listening", { port, allow: [...allow] }));
