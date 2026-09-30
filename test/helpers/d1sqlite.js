import { DatabaseSync } from "node:sqlite";

/**
 * A real SQLite-backed stand-in for the Cloudflare D1 binding used across the
 * worker. D1 is SQLite under the hood, so `node:sqlite` exercises the exact
 * SQL, indexes, and query plans that run in production — unlike the hand-rolled
 * fakes, which cannot reveal a full-table scan or a correlated subquery.
 *
 * It also instruments every executed statement so a test can measure the real
 * cost driver behind D1 billing: rows scanned. `rows_read` is estimated from
 * SQLite's own `EXPLAIN QUERY PLAN` (full `SCAN` of a table costs its whole row
 * count; a correlated scalar subquery multiplies by the outer scan), which is
 * how D1 counts reads and why an unindexed hot query is so expensive.
 */
export class D1Sqlite {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA foreign_keys = OFF;");
    this.log = null; // when set to an array, every executed statement is recorded
    this._planCache = new Map();
  }

  /** Begin recording executed statements (SQL + bound params). */
  startRecording() {
    this.log = [];
    return this.log;
  }

  stopRecording() {
    const log = this.log || [];
    this.log = null;
    return log;
  }

  _record(sql, params, changes = 0) {
    if (this.log) this.log.push({ sql, params, changes });
  }

  _tableRowCount(table) {
    try {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
      return Number(row?.n) || 0;
    } catch {
      return 0;
    }
  }

  _plan(sql) {
    if (this._planCache.has(sql)) return this._planCache.get(sql);
    let rows = [];
    try {
      rows = this.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
    } catch {
      rows = [];
    }
    this._planCache.set(sql, rows);
    return rows;
  }

  /**
   * Estimate rows_read for a single statement the way D1 bills it: the number
   * of rows SQLite must step through. Full scans cost the table's row count;
   * correlated scalar subqueries multiply by the driving scan.
   */
  estimateRowsRead(sql) {
    const plan = this._plan(sql);
    let total = 0;
    let outerScanRows = 0;
    let correlatedTable = null;
    for (const step of plan) {
      const detail = String(step.detail || "");
      const scan = detail.match(/^SCAN (\w+)/);
      const search = detail.match(/^SEARCH (\w+)/);
      const correlated = /CORRELATED SCALAR SUBQUERY/.test(detail);
      if (scan) {
        const rows = this._tableRowCount(scan[1]);
        total += rows;
        if (!correlated) outerScanRows = Math.max(outerScanRows, rows);
      } else if (search) {
        // Indexed lookups touch few rows; treat as cheap but non-zero.
        total += 1;
      }
      if (correlated) {
        const t = (scan || search)?.[1];
        if (t) correlatedTable = t;
      }
    }
    if (correlatedTable && outerScanRows > 1) {
      // A correlated subquery re-scans per outer row: quadratic blow-up.
      total += outerScanRows * this._tableRowCount(correlatedTable);
    }
    return total;
  }

  /** Analyze a recorded statement log into an aggregate rows_read/rows_written report. */
  analyze(log) {
    let rowsRead = 0;
    let rowsWritten = 0;
    let writeStatements = 0;
    let readStatements = 0;
    let fullItemScans = 0;
    let correlated = 0;
    const perSql = new Map();
    const isWrite = (sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql);
    for (const { sql, changes = 0 } of log) {
      const write = isWrite(sql);
      if (write) {
        writeStatements += 1;
        rowsWritten += Number(changes) || 0;
      } else {
        readStatements += 1;
        rowsRead += this.estimateRowsRead(sql);
      }
      const plan = this._plan(sql);
      const planText = plan.map((row) => row.detail).join(" | ");
      if (/SCAN items\b/.test(planText)) fullItemScans += 1;
      if (/CORRELATED SCALAR SUBQUERY/.test(planText)) correlated += 1;
      const entry = perSql.get(sql) || { count: 0, cost: 0, writes: 0, plan: planText };
      entry.count += 1;
      if (write) entry.writes += Number(changes) || 0;
      else entry.cost += this.estimateRowsRead(sql);
      perSql.set(sql, entry);
    }
    return {
      statements: log.length,
      readStatements,
      writeStatements,
      rowsRead,
      rowsWritten,
      fullItemScans,
      correlatedSubqueries: correlated,
      perSql,
    };
  }

  _run(sql, params) {
    const stmt = this.db.prepare(sql);
    const info = stmt.run(...params);
    const changes = Number(info.changes) || 0;
    this._record(sql, params, changes);
    return {
      success: true,
      meta: {
        changes,
        last_row_id: Number(info.lastInsertRowid) || 0,
      },
    };
  }

  _first(sql, params) {
    this._record(sql, params);
    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params);
    return row === undefined ? null : row;
  }

  _all(sql, params) {
    this._record(sql, params);
    const stmt = this.db.prepare(sql);
    return { results: stmt.all(...params), success: true };
  }

  _bound(sql, params) {
    return {
      bind: (...next) => this._bound(sql, next),
      run: () => this._run(sql, params),
      first: () => this._first(sql, params),
      all: () => this._all(sql, params),
      raw: () => this.db.prepare(sql).all(...params),
    };
  }

  prepare(sql) {
    return this._bound(sql, []);
  }

  async batch(statements) {
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const statement of statements) out.push(statement.run());
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  exec(sql) {
    this.db.exec(sql);
  }
}
