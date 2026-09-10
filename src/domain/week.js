/** 週別日期工具：全部以 UTC 計算，避免時區造成跨日誤差。 */

const DAY_MS = 86_400_000;

export function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function toUtc(dateStr) {
  if (!isIsoDate(dateStr)) throw new Error(`無效日期格式（需 YYYY-MM-DD）：${dateStr}`);
  return new Date(`${dateStr}T00:00:00Z`);
}

function toIso(date) {
  return date.toISOString().slice(0, 10);
}

/** 取得該日期所屬週的週一（ISO 週，週日歸屬前一週的週一）。 */
export function mondayOf(dateStr) {
  const d = toUtc(dateStr);
  const dow = d.getUTCDay();              // 0=Sun .. 6=Sat
  const shift = dow === 0 ? -6 : 1 - dow; // 週日往前 6 天
  return toIso(new Date(d.getTime() + shift * DAY_MS));
}

/** 週起始日 + day_of_week(1..5) → ISO 日期。 */
export function dateForDay(weekStartDate, dayOfWeek) {
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 5) {
    throw new Error(`day_of_week 需為 1..5：${dayOfWeek}`);
  }
  return toIso(new Date(toUtc(weekStartDate).getTime() + (dayOfWeek - 1) * DAY_MS));
}

/** ISO 日期 → 該週的 day_of_week(1..5)；不在本週或為週末時回傳 null。 */
export function dayOfWeekFor(weekStartDate, dateStr) {
  const diff = Math.round((toUtc(dateStr).getTime() - toUtc(weekStartDate).getTime()) / DAY_MS);
  return diff >= 0 && diff <= 4 ? diff + 1 : null;
}

/** 相對本週位移 n 週的週一。 */
export function shiftWeeks(weekStartDate, weeks) {
  return toIso(new Date(toUtc(weekStartDate).getTime() + weeks * 7 * DAY_MS));
}

/** 今天所屬週的週一。 */
export function currentWeekStart(today = new Date()) {
  return mondayOf(toIso(today));
}
