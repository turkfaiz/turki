import { extractArticleLinks as newsroomLinks } from "./newsroom.js";
export {
  runScan,
  sourceStatus,
  stampBrief,
  pollOneSource,
  fetchCandidateBatch,
  pendingCandidateCount,
} from "./pipeline.js";

/**
 * يستخرج روابط المقالات من صفحة أخبار الموقع نفسه. الاستخراج محصور في النطاق
 * المعتمد ذاته، فلا تتسع قائمة المصادر ضمنًا عبر روابط خارجة.
 */
export function extractArticleLinks(html, baseUrl, adapterName = "generic") {
  return newsroomLinks(html, baseUrl, adapterName);
}
