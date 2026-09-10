import { DatabaseSync } from "node:sqlite";

/**
 * A D1-shaped adapter over real SQLite.
 *
 * The mistakes that reached production were SQL and migration mistakes: a
 * clause that silently changed ordering, a CREATE TABLE that never added a
 * column, a destructive statement inside a read path. A hand-written fake
 * cannot catch those because it never parses the SQL. This runs the statements
 * the Worker actually issues against a real engine.
 */
export function createTestD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  const normalise = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "number" && !Number.isInteger(value)) return value;
    return value;
  };

  const statement = (sql, bound = []) => ({
    /** D1 returns a new bound statement, so reusing one prepared statement is safe. */
    bind(...args) {
      return statement(sql, args.map(normalise));
    },
    async run() {
      const result = db.prepare(sql).run(...bound);
      return {
        success: true,
        meta: {
          changes: Number(result.changes) || 0,
          last_row_id: Number(result.lastInsertRowid) || 0,
        },
      };
    },
    async first(column) {
      const row = db.prepare(sql).get(...bound) ?? null;
      if (row && column !== undefined) return row[column] ?? null;
      return row;
    },
    async all() {
      return { success: true, results: db.prepare(sql).all(...bound) };
    },
  });

  const adapter = {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      const out = [];
      db.exec("BEGIN");
      try {
        for (const entry of statements) out.push(await entry.run());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return out;
    },
    /** Test-only helpers. */
    exec: (sql) => db.exec(sql),
    query: (sql, ...args) => db.prepare(sql).all(...args),
    one: (sql, ...args) => db.prepare(sql).get(...args) ?? null,
    close: () => db.close(),
    /**
     * A distinct adapter object over the same database. The Worker caches
     * bootstrap per database instance, so a fresh identity lets a test replay
     * an upgrade against data that already exists.
     */
    reopen: () => ({ ...adapter, prepare: (sql) => statement(sql) }),
  };
  return adapter;
}

export function testEnv(overrides = {}) {
  return {
    DB: createTestD1(),
    GEMINI_MODEL: "gemini-test",
    AI_MIN_INTERVAL_MS: "0",
    AI_DAILY_LIMIT: "1000",
    ...overrides,
  };
}
