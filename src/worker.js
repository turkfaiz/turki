import { pruneAiBudget } from "./aiBudget.js";
import { pendingFetchIds } from "./pipeline.js";
import { ARTICLE_FETCH_BATCH } from "./sources.js";
import { briefBacklog } from "./translate.js";
import { verificationBacklog } from "./versions.js";
import { authRequired, authorized, json } from "./api/http.js";
import { handleApi } from "./api/routes.js";
import { publicHealth } from "./api/status.js";
import { WEEKLY_CRON } from "./config.js";
import { ensureDb } from "./db/bootstrap.js";
import { pruneOldItems } from "./db/items.js";
import { processQueuedSearch } from "./jobs/consumers.js";
import { drainBriefs, enqueueAllOffices } from "./jobs/desk.js";
import { enqueueArticleFetches, enqueueBriefPump } from "./jobs/enqueue.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health" && request.method === "GET") {
      try {
        await ensureDb(env);
        return json(await publicHealth(env));
      } catch (error) {
        return json({ ok: false, error: String(error.message || error) }, 500);
      }
    }
    if (!authorized(request, env)) return authRequired();
    await ensureDb(env);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env);
      } catch (err) {
        return json({ error: "server_error", message: String(err.message || err) }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    if (event?.cron === WEEKLY_CRON) {
      ctx.waitUntil(enqueueAllOffices(env));
      return;
    }
    ctx.waitUntil(
      (async () => {
        await ensureDb(env);
        await pruneAiBudget(env);
        await pruneOldItems(env);
        const leftoverFetch = await pendingFetchIds(env, { limit: ARTICLE_FETCH_BATCH * 4 });
        if (leftoverFetch.length && env.SCAN_QUEUE) {
          await enqueueArticleFetches(env, { ids: leftoverFetch });
        }
        const leftover = await briefBacklog(env);
        const verify = await verificationBacklog(env);
        const hasDeskWork =
          leftoverFetch.length > 0 || (leftover.pending || 0) > 0 || (verify.pending || 0) > 0;
        if (!hasDeskWork) return;
        await drainBriefs(env);
        const after = await briefBacklog(env);
        const verifyAfter = await verificationBacklog(env);
        if (after.pending > 0 || verifyAfter.pending > 0) await enqueueBriefPump(env);
      })(),
    );
  },

  async queue(batch, env) {
    await ensureDb(env);
    for (const message of batch.messages) {
      await processQueuedSearch(env, message);
    }
  },
};
