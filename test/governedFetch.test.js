import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCanonicalApproved,
  governedFetch,
  isBlockedHost,
  looksLikeErrorPage,
} from "../src/governedFetch.js";

function response(status, body = "", headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        const hit = Object.entries(headers).find(
          ([key]) => key.toLowerCase() === name.toLowerCase(),
        );
        return hit ? String(hit[1]) : null;
      },
    },
    async text() {
      return body;
    },
  };
}

test("private and metadata hosts are blocked", () => {
  assert.equal(isBlockedHost("127.0.0.1"), true);
  assert.equal(isBlockedHost("10.0.0.8"), true);
  assert.equal(isBlockedHost("192.168.1.9"), true);
  assert.equal(isBlockedHost("169.254.169.254"), true);
  assert.equal(isBlockedHost("localhost"), true);
  assert.equal(isBlockedHost("www.comune.torino.it"), false);
});

test("an in-registry redirect is followed", async () => {
  const fetchImpl = async (url) => {
    if (String(url) === "https://www.comune.torino.it/rss.xml") {
      return response(301, "", { Location: "https://www.comune.torino.it/notizie.xml" });
    }
    return response(200, "<rss><channel></channel></rss>");
  };
  const result = await governedFetch("https://www.comune.torino.it/rss.xml", {
    mayorId: "turin",
    fetch: fetchImpl,
  });
  assert.equal(result.status, 200);
  assert.equal(result.url, "https://www.comune.torino.it/notizie.xml");
});

test("a redirect outside the registry is stopped", async () => {
  const fetchImpl = async () =>
    response(302, "", { Location: "https://evil.example/steal" });
  await assert.rejects(
    () =>
      governedFetch("https://www.comune.torino.it/rss.xml", {
        mayorId: "turin",
        fetch: fetchImpl,
      }),
    /redirect_outside_registry/,
  );
});

test("a private redirect target is stopped", async () => {
  const fetchImpl = async () => response(302, "", { Location: "http://127.0.0.1/admin" });
  await assert.rejects(
    () =>
      governedFetch("https://www.comune.torino.it/rss.xml", {
        mayorId: "turin",
        fetch: fetchImpl,
      }),
    /blocked_host/,
  );
});

test("a javascript location is not followed", async () => {
  const fetchImpl = async () => response(302, "", { Location: "javascript:alert(1)" });
  await assert.rejects(
    () =>
      governedFetch("https://www.comune.torino.it/rss.xml", {
        mayorId: "turin",
        fetch: fetchImpl,
      }),
    /blocked_host|redirect_invalid/,
  );
});

test("a canonical URL outside the registry is rejected", () => {
  const verdict = assertCanonicalApproved(
    "https://news.google.com/articles/abc",
    "turin",
    "https://www.comune.torino.it/a",
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "canonical_outside_registry");
});

test("an HTTP 200 error page is not success", () => {
  const html = "<html><head><title>404 Page Not Found</title></head><body>missing</body></html>";
  const verdict = looksLikeErrorPage(html, 200, "https://www.ammancity.gov.jo/errpage.aspx");
  assert.equal(verdict.error, true);
  assert.equal(verdict.reason, "error_page");
});
