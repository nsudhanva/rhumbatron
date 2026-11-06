import { type CoreLink, coreFetch, expectOk } from "./core.ts";

/**
 * The R2Bucket subset the apps code uses (get, head, put, delete, list) over HTTP to the core
 * service (`/internal/r2/*`, services/apps/CONTRACT.md). No ranges, conditions, multipart, or
 * checksums. Object metadata travels as JSON in the `x-r2-meta` header.
 */

const META = "x-r2-meta";

type R2Meta = {
  key?: string;
  size: number;
  etag: string;
  uploaded: string;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
};

/** JSON safe for a header value: non-ASCII characters are `\uXXXX` escapes. */
const headerJson = (value: unknown) =>
  JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

const objectPath = (key: string) => `/internal/r2/object/${encodeURIComponent(key)}`;

class HttpR2Object {
  readonly key: string;
  readonly version: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly uploaded: Date;
  readonly httpMetadata: R2HTTPMetadata;
  readonly customMetadata: Record<string, string>;
  readonly checksums = { toJSON: () => ({}) } as R2Checksums;
  readonly storageClass = "Standard";

  constructor(key: string, meta: R2Meta) {
    this.key = meta.key ?? key;
    this.size = meta.size;
    this.etag = meta.etag;
    this.version = meta.etag;
    this.httpEtag = `"${meta.etag}"`;
    this.uploaded = new Date(meta.uploaded);
    this.httpMetadata = meta.httpMetadata ?? {};
    this.customMetadata = meta.customMetadata ?? {};
  }

  writeHttpMetadata(headers: Headers): void {
    const m = this.httpMetadata;
    if (m.contentType) headers.set("content-type", m.contentType);
    if (m.contentLanguage) headers.set("content-language", m.contentLanguage);
    if (m.contentDisposition) headers.set("content-disposition", m.contentDisposition);
    if (m.contentEncoding) headers.set("content-encoding", m.contentEncoding);
    if (m.cacheControl) headers.set("cache-control", m.cacheControl);
  }
}

class HttpR2ObjectBody extends HttpR2Object {
  constructor(
    key: string,
    meta: R2Meta,
    private readonly response: Response,
  ) {
    super(key, meta);
  }
  get body(): ReadableStream {
    return this.response.body ?? new ReadableStream();
  }
  get bodyUsed() {
    return this.response.bodyUsed;
  }
  arrayBuffer() {
    return this.response.arrayBuffer();
  }
  async bytes() {
    return new Uint8Array(await this.response.arrayBuffer());
  }
  text() {
    return this.response.text();
  }
  json<T>(): Promise<T> {
    return this.response.json() as Promise<T>;
  }
  blob() {
    return this.response.blob();
  }
}

function readMeta(response: Response, key: string): R2Meta {
  const raw = response.headers.get(META);
  if (!raw) throw new Error(`R2 ${key}: core sent no ${META} header`);
  return JSON.parse(raw) as R2Meta;
}

function httpMetadataOf(value: R2PutOptions["httpMetadata"]): R2HTTPMetadata | undefined {
  if (!(value instanceof Headers)) return value;
  const out: R2HTTPMetadata = {};
  const contentType = value.get("content-type");
  if (contentType) out.contentType = contentType;
  const cacheControl = value.get("cache-control");
  if (cacheControl) out.cacheControl = cacheControl;
  return out;
}

export class HttpR2 {
  constructor(private readonly link: CoreLink) {}

  async head(key: string): Promise<HttpR2Object | null> {
    const response = await coreFetch(this.link, objectPath(key), { method: "HEAD" });
    if (response.status === 404) return null;
    await expectOk(response, `R2 head ${key}`);
    return new HttpR2Object(key, readMeta(response, key));
  }

  async get(key: string): Promise<HttpR2ObjectBody | null> {
    const response = await coreFetch(this.link, objectPath(key));
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    await expectOk(response, `R2 get ${key}`);
    return new HttpR2ObjectBody(key, readMeta(response, key), response);
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options: R2PutOptions = {},
  ): Promise<HttpR2Object> {
    const body = value instanceof ReadableStream ? await new Response(value).arrayBuffer() : value;
    const meta = {
      httpMetadata: httpMetadataOf(options.httpMetadata) ?? {},
      customMetadata: options.customMetadata ?? {},
    };
    const response = await coreFetch(this.link, objectPath(key), {
      method: "PUT",
      headers: { [META]: headerJson(meta), "content-type": "application/octet-stream" },
      body: body ?? "",
    });
    await expectOk(response, `R2 put ${key}`);
    const stored = readMeta(response, key);
    await response.body?.cancel();
    return new HttpR2Object(key, stored);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const response = await coreFetch(this.link, objectPath(key), { method: "DELETE" });
      await expectOk(response, `R2 delete ${key}`, [200, 204, 404]);
      await response.body?.cancel();
    }
  }

  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    const query = new URLSearchParams();
    if (options.prefix) query.set("prefix", options.prefix);
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit) query.set("limit", String(options.limit));
    if (options.delimiter) query.set("delimiter", options.delimiter);
    const response = await coreFetch(this.link, `/internal/r2/list?${query}`);
    const page = (await (await expectOk(response, "R2 list")).json()) as {
      objects: (R2Meta & { key: string })[];
      truncated: boolean;
      cursor?: string;
      delimitedPrefixes: string[];
    };
    const objects = page.objects.map((o) => new HttpR2Object(o.key, o) as unknown as R2Object);
    return page.truncated && page.cursor
      ? {
          objects,
          truncated: true,
          cursor: page.cursor,
          delimitedPrefixes: page.delimitedPrefixes,
        }
      : { objects, truncated: false, delimitedPrefixes: page.delimitedPrefixes };
  }
}
