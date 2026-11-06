import type { Database } from "bun:sqlite";

/**
 * Semantic memory: vectors in a table of the platform database. Search is exact cosine
 * similarity, restricted to one namespace (a Project) before ranking, so one Project never sees
 * another's vectors. A Project holds hundreds of vectors, so an exact scan is fast.
 */

type Metadata = Record<string, string | number | boolean>;
type Vector = {
  id: string;
  values: number[] | Float32Array;
  namespace?: string;
  metadata?: Metadata;
};
type Match = { id: string; score: number; metadata?: Metadata; namespace?: string };

function toBlob(values: number[] | Float32Array): Uint8Array {
  const f = values instanceof Float32Array ? values : Float32Array.from(values);
  return new Uint8Array(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength));
}

function fromBlob(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export class VectorIndex {
  constructor(
    private readonly db: Database,
    private readonly index: string,
    private readonly dimensions: number,
  ) {
    db.run(
      "CREATE TABLE IF NOT EXISTS platform_vectors (idx TEXT NOT NULL, id TEXT NOT NULL, namespace TEXT, embedding BLOB NOT NULL, metadata TEXT, PRIMARY KEY (idx, id)) WITHOUT ROWID",
    );
    db.run("CREATE INDEX IF NOT EXISTS platform_vectors_ns ON platform_vectors (idx, namespace)");
  }

  async upsert(vectors: Vector[]): Promise<{ mutationId: string; count: number }> {
    const statement = this.db.query(
      "INSERT INTO platform_vectors (idx, id, namespace, embedding, metadata) VALUES (?, ?, ?, ?, ?) ON CONFLICT (idx, id) DO UPDATE SET namespace = excluded.namespace, embedding = excluded.embedding, metadata = excluded.metadata",
    );
    this.db.transaction(() => {
      for (const v of vectors) {
        if (v.values.length !== this.dimensions)
          throw new Error(
            `Vector ${v.id} has ${v.values.length} dimensions, expected ${this.dimensions}`,
          );
        statement.run(
          this.index,
          v.id,
          v.namespace ?? null,
          toBlob(v.values),
          v.metadata ? JSON.stringify(v.metadata) : null,
        );
      }
    })();
    return { mutationId: crypto.randomUUID(), count: vectors.length };
  }

  async insert(vectors: Vector[]): Promise<{ mutationId: string; count: number }> {
    return this.upsert(vectors);
  }

  async query(
    values: number[] | Float32Array,
    options: {
      topK?: number;
      namespace?: string;
      returnMetadata?: boolean | "all" | "indexed" | "none";
      returnValues?: boolean;
      filter?: Record<string, unknown>;
    } = {},
  ): Promise<{ matches: Match[]; count: number }> {
    const target = values instanceof Float32Array ? values : Float32Array.from(values);
    const rows = (
      options.namespace === undefined
        ? this.db
            .query("SELECT id, namespace, embedding, metadata FROM platform_vectors WHERE idx = ?")
            .all(this.index)
        : this.db
            .query(
              "SELECT id, namespace, embedding, metadata FROM platform_vectors WHERE idx = ? AND namespace = ?",
            )
            .all(this.index, options.namespace)
    ) as { id: string; namespace: string | null; embedding: Uint8Array; metadata: string | null }[];
    const wantMeta =
      options.returnMetadata !== undefined &&
      options.returnMetadata !== false &&
      options.returnMetadata !== "none";
    const matches = rows
      .map((row) => {
        const metadata = row.metadata ? (JSON.parse(row.metadata) as Metadata) : undefined;
        return { row, metadata, score: cosine(target, fromBlob(row.embedding)) };
      })
      .filter(
        ({ metadata }) =>
          !options.filter || Object.entries(options.filter).every(([k, v]) => metadata?.[k] === v),
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, options.topK ?? 5)
      .map(({ row, metadata, score }) => ({
        id: row.id,
        score,
        ...(row.namespace ? { namespace: row.namespace } : {}),
        ...(wantMeta && metadata ? { metadata } : {}),
      }));
    return { matches, count: matches.length };
  }

  async deleteByIds(ids: string[]): Promise<{ mutationId: string; count: number }> {
    const statement = this.db.query("DELETE FROM platform_vectors WHERE idx = ? AND id = ?");
    this.db.transaction(() => {
      for (const id of ids) statement.run(this.index, id);
    })();
    return { mutationId: crypto.randomUUID(), count: ids.length };
  }

  async getByIds(ids: string[]): Promise<Vector[]> {
    const statement = this.db.query(
      "SELECT id, namespace, embedding, metadata FROM platform_vectors WHERE idx = ? AND id = ?",
    );
    return ids.flatMap((id) => {
      const row = statement.get(this.index, id) as {
        id: string;
        namespace: string | null;
        embedding: Uint8Array;
        metadata: string | null;
      } | null;
      return row
        ? [
            {
              id: row.id,
              values: Array.from(fromBlob(row.embedding)),
              ...(row.namespace ? { namespace: row.namespace } : {}),
              ...(row.metadata ? { metadata: JSON.parse(row.metadata) } : {}),
            },
          ]
        : [];
    });
  }
}
