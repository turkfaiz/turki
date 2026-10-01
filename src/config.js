import { DISPLAY_WINDOW_DAYS } from "./deskLanes.js";

export const WEEKLY_CRON = "0 3 * * SUN";

/** نافذة الرصد سبعة أيام، ويُحفظ يومان إضافيان لاستقرار الترحيل. */
export const ITEM_WINDOW_DAYS = DISPLAY_WINDOW_DAYS;

export const ITEM_RETENTION_DAYS = 9;

export const BRIEF_BATCH_SIZE = 3;

export const DRAIN_MAX_BRIEFS = 8;

export const DRAIN_MAX_MS = 40000;

export const CONTINUATION_MIN_SECONDS = 10;

export const CONTINUATION_MAX_SECONDS = 900;

/** التأجيل الطويل (كنفاد حصة اليوم) يُترك لمهمة التصريف الدورية لا للطابور. */
export const CONTINUATION_DEFER_CEILING = 300;
