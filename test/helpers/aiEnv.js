/**
 * In-memory stand-in for the D1 statements the AI budget governor issues.
 * It mirrors the semantics of the real SQL so callers can be tested without a
 * database, while the production statement keeps the atomicity guarantee.
 */
function nowMs() {
  return Date.now();
}

function parseModifierSeconds(modifier) {
  const match = String(modifier || "").match(/(-?\d+(?:\.\d+)?)\s*seconds/);
  return match ? Number(match[1]) : 0;
}

function isoSql(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function parseSql(value) {
  return value ? Date.parse(`${String(value).replace(" ", "T")}Z`) : 0;
}

export function fakeBudgetDb(store = { row: null }) {
  const statement = (sql) => ({
    bind(...binds) {
      return {
        async run() {
          if (/INSERT INTO ai_budget/.test(sql) && /ON CONFLICT\(day\) DO UPDATE\s+SET calls/.test(sql)) {
            const [day, limit, pacing] = binds;
            if (!store.row) {
              store.row = { day, calls: 1, last_call_at: isoSql(nowMs()), blocked_until: null, block_reason: null };
              return { meta: { changes: 1 } };
            }
            const blocked = parseSql(store.row.blocked_until) > nowMs();
            const paceFloor = nowMs() + parseModifierSeconds(pacing) * 1000;
            const paced = parseSql(store.row.last_call_at) > paceFloor;
            if (blocked || paced || store.row.calls >= Number(limit)) {
              return { meta: { changes: 0 } };
            }
            store.row.calls += 1;
            store.row.last_call_at = isoSql(nowMs());
            return { meta: { changes: 1 } };
          }
          if (/INSERT INTO ai_budget/.test(sql)) {
            const [day, plus, reason] = binds;
            const until = isoSql(nowMs() + parseModifierSeconds(plus) * 1000);
            if (!store.row) {
              store.row = { day, calls: 0, last_call_at: null, blocked_until: until, block_reason: reason };
            } else {
              store.row.blocked_until =
                parseSql(store.row.blocked_until) > parseSql(until) ? store.row.blocked_until : until;
              store.row.block_reason = reason;
            }
            return { meta: { changes: 1 } };
          }
          if (/DELETE FROM ai_budget/.test(sql)) {
            store.row = null;
            return { meta: { changes: 1 } };
          }
          throw new Error(`unexpected sql in test db: ${sql}`);
        },
        async first() {
          if (/SELECT day, calls/.test(sql)) return store.row;
          throw new Error(`unexpected sql in test db: ${sql}`);
        },
      };
    },
  });
  return { prepare: statement, __store: store };
}

export function aiEnv(extra = {}) {
  return {
    GEMINI_API_KEY: "secret",
    GEMINI_MODEL: "gemini-test",
    AI_MIN_INTERVAL_MS: "0",
    AI_DAILY_LIMIT: "1000",
    ...extra,
    DB: extra.DB || fakeBudgetDb(),
  };
}
