/** Serialized admission and immutable registration receipts, stored in ProjectRootDO SQLite. */
export type RequestCriterion = { id: string; text: string };
export type RequestScope = {
  changeId: string;
  requesterUserId: string;
  requesterRank: number;
  criteria: RequestCriterion[];
  resources: string[];
  scoped: boolean;
};
export type RegisterScopeInput = Omit<RequestScope, "scoped"> & { registeredAt: string };
export type ScopeRegistration = { order: number; earlier: RequestScope[] };

type Row = {
  change_id: string;
  admission_order: number;
  scope_json: string | null;
  receipt_json: string | null;
  released: number;
};

export class RequestScopes {
  constructor(private readonly sql: SqlStorage) {}

  migrate() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS request_scopes (
      admission_order INTEGER PRIMARY KEY AUTOINCREMENT,
      change_id TEXT NOT NULL UNIQUE,
      scope_json TEXT,
      receipt_json TEXT,
      registered_at TEXT,
      released INTEGER NOT NULL DEFAULT 0
    )`);
  }

  admit(changeId: string, requester?: { requesterUserId: string; requesterRank: number }): number {
    this.sql.exec("INSERT OR IGNORE INTO request_scopes (change_id) VALUES (?)", changeId);
    if (requester)
      this.sql.exec(
        "UPDATE request_scopes SET scope_json = ? WHERE change_id = ? AND scope_json IS NULL",
        JSON.stringify({ changeId, ...requester, criteria: [], resources: [], scoped: false }),
        changeId,
      );
    return this.row(changeId).admission_order;
  }

  private row(changeId: string): Row {
    const row = this.sql
      .exec<Row>("SELECT * FROM request_scopes WHERE change_id = ?", changeId)
      .toArray()[0];
    if (!row) throw new Error("Request has not been admitted");
    return row;
  }

  scope(changeId: string): RequestScope | null {
    const row = this.sql
      .exec<Row>("SELECT * FROM request_scopes WHERE change_id = ? AND released = 0", changeId)
      .toArray()[0];
    if (!row) return null;
    return row.scope_json
      ? (JSON.parse(row.scope_json) as RequestScope)
      : {
          changeId,
          requesterUserId: "",
          requesterRank: 10,
          criteria: [],
          resources: [],
          scoped: false,
        };
  }

  register(input: RegisterScopeInput): ScopeRegistration {
    const order = this.admit(input.changeId);
    const existing = this.row(input.changeId);
    if (existing.receipt_json) return JSON.parse(existing.receipt_json) as ScopeRegistration;
    const earlier = this.sql
      .exec<Row>(
        "SELECT * FROM request_scopes WHERE admission_order < ? AND released = 0 ORDER BY admission_order",
        order,
      )
      .toArray()
      .map((row) => this.scope(row.change_id))
      .filter((scope): scope is RequestScope => scope !== null);
    const receipt = { order, earlier };
    const { registeredAt, ...scope } = input;
    this.sql.exec(
      "UPDATE request_scopes SET scope_json = ?, receipt_json = ?, registered_at = ? WHERE change_id = ?",
      JSON.stringify({ ...scope, scoped: true }),
      JSON.stringify(receipt),
      registeredAt,
      input.changeId,
    );
    return receipt;
  }

  update(input: RegisterScopeInput) {
    const { registeredAt: _, ...scope } = input;
    this.sql.exec(
      "UPDATE request_scopes SET scope_json = ? WHERE change_id = ? AND released = 0",
      JSON.stringify({ ...scope, scoped: true }),
      input.changeId,
    );
  }

  release(changeId: string) {
    // Keep the receipt: a retry must never acquire a new order or a new earlier set.
    this.sql.exec("UPDATE request_scopes SET released = 1 WHERE change_id = ?", changeId);
  }
}
