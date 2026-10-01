/**
 * يفحص مصادر المكاتب المعتمدة بنفس كود الرصد الفعلي، من جهازك أنت لا من Cloudflare.
 *
 *   npm run check:sources                 كل المكاتب
 *   npm run check:sources -- turin        مكتب واحد
 *
 * لكل مصدر: الحالة، وعدد الروابط الحديثة التي وجدها، وكم منها يذكر العمدة في عنوانه.
 * لا يكتب في أي قاعدة بيانات ولا يستدعي الذكاء الاصطناعي.
 */
import { MAYORS, isAboutMayor } from "../src/mayors.js";
import { sourcesFor } from "../src/sources.js";
import { discoverSource } from "../src/discovery.js";

const only = process.argv[2];
const mayors = only ? MAYORS.filter((mayor) => mayor.id === only) : MAYORS;
if (!mayors.length) {
  console.error(`مكتب غير معروف: ${only}\nالمتاح: ${MAYORS.map((mayor) => mayor.id).join(", ")}`);
  process.exit(1);
}

for (const mayor of mayors) {
  console.log(`\n== ${mayor.id} — ${mayor.name_en}`);
  for (const source of sourcesFor(mayor.id)) {
    try {
      const { rows, health } = await discoverSource(source, mayor, {});
      const about = rows.filter((row) => isAboutMayor(`${row.title || ""} ${row.snippet || ""}`, mayor));
      const verdict = health.ok ? "OK " : "BAD";
      console.log(
        `${verdict} ${source.domain.padEnd(28)} ${String(health.status).padEnd(16)} روابط حديثة: ${String(rows.length).padStart(3)} · تذكر العمدة: ${about.length}${health.fail_reason ? ` · ${health.fail_reason}` : ""}`,
      );
      for (const row of about.slice(0, 2)) console.log(`      - ${String(row.title).slice(0, 90)}`);
    } catch (error) {
      console.log(`ERR ${source.domain} ${String(error.message || error).slice(0, 100)}`);
    }
  }
}
