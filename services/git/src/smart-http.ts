/**
 * Git smart HTTP through `git http-backend` (CGI). Only the smart protocol is served:
 * `info/refs?service=...`, `git-upload-pack`, and `git-receive-pack`. Dumb-protocol paths are
 * refused. A read token allows only `git-upload-pack`.
 */
import { gitEnv } from "./git.ts";
import type { GitService, Store } from "./store.ts";

const ROUTE = /^\/git\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.git(\/.*)$/;

/** The Git service a request asks for, or null for a path that this server does not serve. */
function serviceOf(method: string, rest: string, query: URLSearchParams): GitService | null {
  if (method === "GET" && rest === "/info/refs") {
    const service = query.get("service");
    return service === "git-upload-pack" || service === "git-receive-pack" ? service : null;
  }
  if (method === "POST" && rest === "/git-upload-pack") return "git-upload-pack";
  if (method === "POST" && rest === "/git-receive-pack") return "git-receive-pack";
  return null;
}

/** Token from HTTP Basic (the password) or a Bearer header. */
function credential(header: string | null): string | null {
  if (!header) return null;
  const [kind = "", value = ""] = header.trim().split(/\s+/, 2);
  if (kind.toLowerCase() === "bearer") return value || null;
  if (kind.toLowerCase() !== "basic") return null;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon === -1 ? null : decoded.slice(colon + 1) || null;
  } catch {
    return null;
  }
}

const deny = (status: number, message: string) =>
  new Response(`${message}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...(status === 401 ? { "www-authenticate": 'Basic realm="rhumbatron-git"' } : {}),
    },
  });

export function isGitPath(pathname: string) {
  return pathname.startsWith("/git/");
}

export async function serveGit(store: Store, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const match = ROUTE.exec(url.pathname);
  if (!match) return deny(404, "not found");
  const [, name = "", rest = ""] = match;
  const service = serviceOf(req.method, rest, url.searchParams);
  if (!service) return deny(404, "only the smart HTTP protocol is served");

  const auth = store.authorize(credential(req.headers.get("authorization")), name, service);
  if (!auth.ok) return deny(auth.status, auth.message);

  const env = gitEnv({
    GIT_PROJECT_ROOT: store.root,
    GIT_HTTP_EXPORT_ALL: "1",
    GIT_HTTP_MAX_REQUEST_BUFFER: "100M",
    PATH_INFO: `/${name}.git${rest}`,
    REQUEST_METHOD: req.method,
    QUERY_STRING: url.search.slice(1),
    REMOTE_USER: auth.tokenId,
    REMOTE_ADDR: "127.0.0.1",
  });
  const contentType = req.headers.get("content-type");
  if (contentType) env.CONTENT_TYPE = contentType;
  const contentLength = req.headers.get("content-length");
  if (contentLength) env.CONTENT_LENGTH = contentLength;
  const encoding = req.headers.get("content-encoding");
  if (encoding) env.HTTP_CONTENT_ENCODING = encoding;
  const protocol = req.headers.get("git-protocol");
  if (protocol) env.GIT_PROTOCOL = protocol;

  const proc = Bun.spawn(["git", "http-backend"], {
    env,
    stdin: req.method === "POST" && req.body ? req.body : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  void proc.exited.then(async (code) => {
    if (code === 0 && service === "git-receive-pack" && req.method === "POST") {
      store.notePush(name);
    }
    if (code !== 0) {
      console.error(
        JSON.stringify({
          event: "git.http_backend_failed",
          repo: name,
          service,
          code,
          stderr: (await stderr).slice(-300),
        }),
      );
    }
  });
  return cgiResponse(proc.stdout);
}

const CRLF2 = [13, 10, 13, 10];
const LF2 = [10, 10];

function indexOfSeq(buf: Uint8Array, seq: number[]) {
  outer: for (let i = 0; i + seq.length <= buf.length; i += 1) {
    for (let j = 0; j < seq.length; j += 1) if (buf[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

/** Parses the CGI header block and streams the rest of stdout as the response body. */
async function cgiResponse(stdout: ReadableStream<Uint8Array>): Promise<Response> {
  const reader = stdout.getReader();
  let buf = new Uint8Array(0);
  let end = -1;
  let sep = 0;
  while (end === -1) {
    const { value, done } = await reader.read();
    if (done) break;
    const next = new Uint8Array(buf.length + value.length);
    next.set(buf);
    next.set(value, buf.length);
    buf = next;
    const crlf = indexOfSeq(buf, CRLF2);
    const lf = indexOfSeq(buf, LF2);
    if (crlf !== -1 && (lf === -1 || crlf < lf)) {
      end = crlf;
      sep = 4;
    } else if (lf !== -1) {
      end = lf;
      sep = 2;
    }
    if (end === -1 && buf.length > 65_536) break;
  }
  if (end === -1) {
    await reader.cancel();
    return deny(502, "git http-backend returned no headers");
  }
  const headers = new Headers();
  let status = 200;
  for (const line of new TextDecoder().decode(buf.subarray(0, end)).split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
    else headers.append(key, value);
  }
  const head = buf.subarray(end + sep);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length > 0) controller.enqueue(head);
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() {
      return reader.cancel();
    },
  });
  return new Response(body, { status, headers });
}
