import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * An object bucket on any S3-compatible store (versitygw in the Compose stack). It has the
 * bucket client surface the code uses: `get`, `put`, `head`, `delete` and `list` with
 * `httpMetadata` and `customMetadata`.
 */

type HttpMetadata = {
  contentType?: string;
  contentEncoding?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentLanguage?: string;
};

export type StoredObject = {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata: HttpMetadata;
  customMetadata: Record<string, string>;
  version: string;
  writeHttpMetadata(headers: Headers): void;
};

export type StoredObjectBody = StoredObject & {
  body: ReadableStream<Uint8Array>;
  bodyUsed: boolean;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
  blob(): Promise<Blob>;
};

export type BucketConfig = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

type Head = {
  ContentLength?: number | undefined;
  ETag?: string | undefined;
  LastModified?: Date | undefined;
  ContentType?: string | undefined;
  ContentEncoding?: string | undefined;
  CacheControl?: string | undefined;
  ContentDisposition?: string | undefined;
  ContentLanguage?: string | undefined;
  Metadata?: Record<string, string> | undefined;
};

function meta(key: string, head: Head): StoredObject {
  const etag = (head.ETag ?? "").replaceAll('"', "");
  const httpMetadata: HttpMetadata = {
    ...(head.ContentType ? { contentType: head.ContentType } : {}),
    ...(head.ContentEncoding ? { contentEncoding: head.ContentEncoding } : {}),
    ...(head.CacheControl ? { cacheControl: head.CacheControl } : {}),
    ...(head.ContentDisposition ? { contentDisposition: head.ContentDisposition } : {}),
    ...(head.ContentLanguage ? { contentLanguage: head.ContentLanguage } : {}),
  };
  return {
    key,
    size: head.ContentLength ?? 0,
    etag,
    httpEtag: `"${etag}"`,
    uploaded: head.LastModified ?? new Date(),
    httpMetadata,
    customMetadata: head.Metadata ?? {},
    version: etag,
    writeHttpMetadata(headers: Headers) {
      if (httpMetadata.contentType) headers.set("content-type", httpMetadata.contentType);
      if (httpMetadata.contentEncoding)
        headers.set("content-encoding", httpMetadata.contentEncoding);
      if (httpMetadata.cacheControl) headers.set("cache-control", httpMetadata.cacheControl);
      if (httpMetadata.contentDisposition)
        headers.set("content-disposition", httpMetadata.contentDisposition);
      if (httpMetadata.contentLanguage)
        headers.set("content-language", httpMetadata.contentLanguage);
    },
  };
}

function isMissing(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

async function toBytes(value: unknown): Promise<Uint8Array> {
  if (value === null || value === undefined) return new Uint8Array();
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ReadableStream)
    return new Uint8Array(await new Response(value).arrayBuffer());
  throw new TypeError("Unsupported object body");
}

export class ObjectBucket {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(config: BucketConfig) {
    this.#client = new S3Client({
      endpoint: config.endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
    this.#bucket = config.bucket;
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      return meta(
        key,
        await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key })),
      );
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async get(
    key: string,
    options?: { range?: { offset?: number; length?: number } },
  ): Promise<StoredObjectBody | null> {
    try {
      const range = options?.range
        ? `bytes=${options.range.offset ?? 0}-${options.range.length ? (options.range.offset ?? 0) + options.range.length - 1 : ""}`
        : undefined;
      const out = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          ...(range ? { Range: range } : {}),
        }),
      );
      const bytes = await out.Body?.transformToByteArray();
      const data: Uint8Array<ArrayBuffer> = bytes ? new Uint8Array(bytes) : new Uint8Array();
      let used = false;
      const read = (): Uint8Array<ArrayBuffer> => {
        used = true;
        return data;
      };
      return {
        ...meta(key, out),
        get body() {
          return new Response(read()).body as ReadableStream<Uint8Array>;
        },
        get bodyUsed() {
          return used;
        },
        text: async () => new TextDecoder().decode(read()),
        json: async <T>() => JSON.parse(new TextDecoder().decode(read())) as T,
        arrayBuffer: async () => read().slice().buffer as ArrayBuffer,
        bytes: async () => read(),
        blob: async () => new Blob([read()]),
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async put(
    key: string,
    value: unknown,
    options: {
      httpMetadata?: HttpMetadata | Headers;
      customMetadata?: Record<string, string>;
    } = {},
  ): Promise<StoredObject> {
    const body = await toBytes(value);
    const http: HttpMetadata =
      options.httpMetadata instanceof Headers
        ? {
            ...(options.httpMetadata.get("content-type")
              ? { contentType: options.httpMetadata.get("content-type") as string }
              : {}),
          }
        : (options.httpMetadata ?? {});
    const out = await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ContentLength: body.byteLength,
        ...(http.contentType ? { ContentType: http.contentType } : {}),
        ...(http.contentEncoding ? { ContentEncoding: http.contentEncoding } : {}),
        ...(http.cacheControl ? { CacheControl: http.cacheControl } : {}),
        ...(http.contentDisposition ? { ContentDisposition: http.contentDisposition } : {}),
        ...(options.customMetadata ? { Metadata: options.customMetadata } : {}),
      }),
    );
    return meta(key, {
      ContentLength: body.byteLength,
      ETag: out.ETag,
      LastModified: new Date(),
      ContentType: http.contentType,
      Metadata: options.customMetadata,
    });
  }

  async delete(keys: string | string[]): Promise<void> {
    if (typeof keys === "string") {
      await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: keys }));
      return;
    }
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      if (chunk.length)
        await this.#client.send(
          new DeleteObjectsCommand({
            Bucket: this.#bucket,
            Delete: { Objects: chunk.map((Key) => ({ Key })) },
          }),
        );
    }
  }

  async list(
    options: {
      prefix?: string;
      cursor?: string;
      limit?: number;
      delimiter?: string;
      startAfter?: string;
      include?: string[];
    } = {},
  ): Promise<{
    objects: StoredObject[];
    truncated: boolean;
    cursor?: string;
    delimitedPrefixes: string[];
  }> {
    const out = await this.#client.send(
      new ListObjectsV2Command({
        Bucket: this.#bucket,
        ...(options.prefix ? { Prefix: options.prefix } : {}),
        ...(options.cursor ? { ContinuationToken: options.cursor } : {}),
        ...(options.delimiter ? { Delimiter: options.delimiter } : {}),
        ...(options.startAfter ? { StartAfter: options.startAfter } : {}),
        MaxKeys: Math.min(options.limit ?? 1000, 1000),
      }),
    );
    const wantMeta =
      options.include?.includes("customMetadata") || options.include?.includes("httpMetadata");
    const objects = await Promise.all(
      (out.Contents ?? []).map(async (o) => {
        const key = o.Key ?? "";
        if (wantMeta)
          return (
            (await this.head(key)) ??
            meta(key, { ContentLength: o.Size, ETag: o.ETag, LastModified: o.LastModified })
          );
        return meta(key, { ContentLength: o.Size, ETag: o.ETag, LastModified: o.LastModified });
      }),
    );
    return {
      objects,
      truncated: out.IsTruncated ?? false,
      ...(out.NextContinuationToken ? { cursor: out.NextContinuationToken } : {}),
      delimitedPrefixes: (out.CommonPrefixes ?? []).map((p) => p.Prefix ?? ""),
    };
  }
}
