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
  if (!store.rows) store.rows = new Map();

  const keyOf = (day, provider) => `${day}::${provider || "gemini"}`;
  const getRow = (day, provider) => {
    const found = store.rows.get(keyOf(day, provider));
    if (found) return found;
    if ((provider || "gemini") === "gemini") return store.row;
    return null;
  };
  const setRow = (day, provider, row) => {
    store.rows.set(keyOf(day, provider), row);
    if ((provider || "gemini") === "gemini") store.row = row;
  };

  const statement = (sql) => ({
    bind(...binds) {
      return {
        async run() {
          if (
            /INSERT INTO ai_provider_budget/.test(sql) &&
            /ON CONFLICT\(day, provider\) DO UPDATE\s+SET calls/.test(sql)
          ) {
            const [day, provider, limit, pacing] = binds;
            const existing = getRow(day, provider);
            if (!existing) {
              const row = {
                day,
                provider,
                calls: 1,
                last_call_at: isoSql(nowMs()),
                blocked_until: null,
                block_reason: null,
              };
              setRow(day, provider, row);
              return { meta: { changes: 1 } };
            }
            const blocked = parseSql(existing.blocked_until) > nowMs();
            const paceFloor = nowMs() + parseModifierSeconds(pacing) * 1000;
            const paced = parseSql(existing.last_call_at) > paceFloor;
            if (blocked || paced || existing.calls >= Number(limit)) {
              return { meta: { changes: 0 } };
            }
            existing.calls += 1;
            existing.last_call_at = isoSql(nowMs());
            setRow(day, provider, existing);
            return { meta: { changes: 1 } };
          }
          if (/INSERT INTO ai_provider_budget/.test(sql)) {
            const [day, provider, plus, reason] = binds;
            const until = isoSql(nowMs() + parseModifierSeconds(plus) * 1000);
            const existing = getRow(day, provider);
            if (!existing) {
              setRow(day, provider, {
                day,
                provider,
                calls: 0,
                last_call_at: null,
                blocked_until: until,
                block_reason: reason,
              });
            } else {
              existing.blocked_until =
                parseSql(existing.blocked_until) > parseSql(until)
                  ? existing.blocked_until
                  : until;
              existing.block_reason = reason;
              setRow(day, provider, existing);
            }
            return { meta: { changes: 1 } };
          }
          if (/DELETE FROM ai_provider_budget/.test(sql) || /DELETE FROM ai_budget/.test(sql)) {
            store.row = null;
            store.rows.clear();
            return { meta: { changes: 1 } };
          }
          throw new Error(`unexpected sql in test db: ${sql}`);
        },
        async first() {
          if (/FROM ai_provider_budget WHERE day = \? AND provider = \?/.test(sql)) {
            return getRow(binds[0], binds[1]);
          }
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
