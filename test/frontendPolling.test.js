import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * The dashboard used to poll /api/stats and /api/diagnostics every few seconds
 * while a search ran, and each of those endpoints full-scans the items table.
 * That polling was the main driver of the D1 rows_read blow-up. This loads the
 * real page script against a stub DOM and asserts the diagnostics aggregates
 * are not requested while their panel is closed.
 */
function loadPageScript({ diagnosticsOpen }) {
  const fetchCalls = [];
  const store = new Map();
  const element = (id) => {
    if (!store.has(id)) {
      store.set(id, {
        id,
        innerHTML: "",
        textContent: "",
        hidden: false,
        open: id === "diagnostics" ? diagnosticsOpen : false,
        value: "",
        dataset: {},
        style: {},
        disabled: false,
        classList: { toggle() {}, add() {}, remove() {} },
        addEventListener() {},
        setAttribute() {},
        getAttribute: () => "false",
        querySelectorAll: () => [],
        closest: () => null,
      });
    }
    return store.get(id);
  };
  globalThis.document = {
    getElementById: element,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  globalThis.window = { setInterval: () => 0, clearInterval() {} };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.fetch = async (path) => {
    fetchCalls.push(String(path));
    return { ok: true, async json() { return { tools: [], mayors: [] }; } };
  };

  let code = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const bootstrap = code.indexOf("loadMayors().then");
  if (bootstrap !== -1) code = code.slice(0, bootstrap);
  const exported = new Function(`${code}\nreturn { loadDiagnostics };`)();
  return { ...exported, fetchCalls, element };
}

test("diagnostics aggregates are not fetched while the panel is closed", async () => {
  const page = loadPageScript({ diagnosticsOpen: false });
  await page.loadDiagnostics();
  assert.equal(
    page.fetchCalls.filter((url) => url.includes("/api/diagnostics")).length,
    0,
    "closed diagnostics panel must not trigger the expensive aggregate query",
  );
});

test("diagnostics aggregates are fetched when the operator opens the panel", async () => {
  const page = loadPageScript({ diagnosticsOpen: true });
  await page.loadDiagnostics();
  assert.equal(
    page.fetchCalls.filter((url) => url.includes("/api/diagnostics")).length,
    1,
    "an open diagnostics panel should load its data once",
  );
});
