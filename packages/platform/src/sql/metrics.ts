import type { Database } from "bun:sqlite";

/**
 * High-cardinality metrics as rows in the platform database. It has the `writeDataPoint` surface
 * the code uses. Rows older than 30 days are removed at start.
 */
export class MetricsDataset {
  constructor(
    private readonly db: Database,
    private readonly dataset: string,
  ) {
    db.run(
      "CREATE TABLE IF NOT EXISTS platform_metrics (id INTEGER PRIMARY KEY, dataset TEXT NOT NULL, at INTEGER NOT NULL, indexes TEXT, blobs TEXT, doubles TEXT)",
    );
    db.run("CREATE INDEX IF NOT EXISTS platform_metrics_at ON platform_metrics (dataset, at)");
    db.query("DELETE FROM platform_metrics WHERE at < ?").run(Date.now() - 30 * 86_400_000);
  }

  writeDataPoint(point: { indexes?: unknown[]; blobs?: unknown[]; doubles?: number[] } = {}): void {
    this.db
      .query(
        "INSERT INTO platform_metrics (dataset, at, indexes, blobs, doubles) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        this.dataset,
        Date.now(),
        JSON.stringify(point.indexes ?? []),
        JSON.stringify(point.blobs ?? []),
        JSON.stringify(point.doubles ?? []),
      );
  }
}
