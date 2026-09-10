/** 班表服務層：生成、覆寫、補位、發布結算。 */

import { BOARD, SHIFT, WARNING, WEEK_DAYS } from '../domain/constants.js';
import { generateWeeklyPlan } from '../domain/scheduler.js';
import { CONFLICT_LABEL, buildBoardIndex, checkConflicts, recommendReplacements } from '../domain/planX.js';
import { dateForDay, dayOfWeekFor, mondayOf } from '../domain/week.js';
import { withTransaction } from '../db/index.js';
import * as repo from './repository.js';

const nowIso = () => new Date().toISOString();

function weekRange(weekStartDate) {
  return { from: weekStartDate, to: dateForDay(weekStartDate, 5) };
}

function absencesForWeek(db, weekStartDate) {
  const { from, to } = weekRange(weekStartDate);
  return repo.listAbsences(db, from, to).map((a) => ({
    ...a,
    day_of_week: dayOfWeekFor(weekStartDate, a.absence_date),
  }));
}

/** 取得（必要時建立）該週班表主檔。 */
export function ensureSchedule(db, rawWeek) {
  const weekStartDate = mondayOf(rawWeek);
  const existing = repo.findSchedule(db, weekStartDate);
  if (existing) return existing;
  repo.createSchedule(db, weekStartDate);
  return repo.findSchedule(db, weekStartDate);
}

/**
 * 一鍵自動排班 —— 規格 §4。
 * 重新生成會整批覆蓋該週明細（含既有手動覆寫），為不可逆操作。
 */
export function generate(db, rawWeek, { standbyCount = 3 } = {}) {
  const schedule = ensureSchedule(db, rawWeek);
  const weekStartDate = schedule.week_start_date;

  const plan = generateWeeklyPlan({
    staff: repo.listStaff(db),
    items: repo.listItems(db),
    stats: repo.fairnessMap(db),
    absences: absencesForWeek(db, weekStartDate),
    weekStartDate,
    standbyCount,
  });

  withTransaction(db, () => {
    repo.replaceScheduleItems(db, schedule.schedule_id, plan.assignments);
    db.prepare('UPDATE weekly_schedules SET generated_at = ? WHERE schedule_id = ?')
      .run(nowIso(), schedule.schedule_id);
    settleFairness(db, schedule.schedule_id);
  });

  return { ...getWeekView(db, weekStartDate), generationWarnings: plan.warnings };
}

/**
 * 公平性結算 —— 規格 §4.5。
 * 先沖銷本班表既有帳本，再依「已發布」狀態重新結算，確保重複呼叫冪等。
 */
export function settleFairness(db, scheduleId) {
  const previous = db.prepare('SELECT * FROM fairness_ledger WHERE schedule_id = ?').all(scheduleId);
  const adjust = db.prepare(
    `UPDATE fairness_stats
        SET blackboard_count         = MAX(0, blackboard_count + ?),
            morning_whiteboard_count = MAX(0, morning_whiteboard_count + ?),
            noon_whiteboard_count    = MAX(0, noon_whiteboard_count + ?)
      WHERE staff_id = ?`,
  );

  for (const row of previous) {
    adjust.run(-row.blackboard_delta, -row.morning_delta, -row.noon_delta, row.staff_id);
  }
  db.prepare('DELETE FROM fairness_ledger WHERE schedule_id = ?').run(scheduleId);

  const schedule = repo.findScheduleById(db, scheduleId);
  if (!schedule || schedule.status !== 'PUBLISHED') return;

  const items = repo.itemsById(db);
  const deltas = new Map();
  for (const row of repo.listScheduleItems(db, scheduleId)) {
    if (row.staff_id == null || row.is_plan_b_standby) continue;
    const item = items.get(row.item_id);
    if (!item) continue;

    if (!deltas.has(row.staff_id)) deltas.set(row.staff_id, { blackboard: 0, morning: 0, noon: 0 });
    const d = deltas.get(row.staff_id);
    if (item.board_type === BOARD.BLACKBOARD) d.blackboard += 1;
    else if (item.shift_type === SHIFT.MORNING) d.morning += 1;
    else if (item.shift_type === SHIFT.NOON) d.noon += 1;
  }

  const insertLedger = db.prepare(
    `INSERT INTO fairness_ledger (schedule_id, staff_id, blackboard_delta, morning_delta, noon_delta, applied_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const ensureStat = db.prepare('INSERT OR IGNORE INTO fairness_stats (staff_id) VALUES (?)');
  const stamp = nowIso();

  for (const [staffId, d] of deltas) {
    ensureStat.run(staffId);
    insertLedger.run(scheduleId, staffId, d.blackboard, d.morning, d.noon, stamp);
    adjust.run(d.blackboard, d.morning, d.noon, staffId);
  }
}

/** 發布班表：狀態轉為 PUBLISHED 並結算公平性統計。 */
export function publish(db, scheduleId) {
  const schedule = repo.findScheduleById(db, scheduleId);
  if (!schedule) throw Object.assign(new Error('班表不存在'), { status: 404 });

  withTransaction(db, () => {
    db.prepare('UPDATE weekly_schedules SET status = \'PUBLISHED\', published_at = ? WHERE schedule_id = ?')
      .run(nowIso(), scheduleId);
    settleFairness(db, scheduleId);
  });

  return getWeekView(db, schedule.week_start_date);
}

/** 撤回發布：回到草稿並沖銷本次結算。 */
export function unpublish(db, scheduleId) {
  const schedule = repo.findScheduleById(db, scheduleId);
  if (!schedule) throw Object.assign(new Error('班表不存在'), { status: 404 });

  withTransaction(db, () => {
    db.prepare('UPDATE weekly_schedules SET status = \'DRAFT\', published_at = NULL WHERE schedule_id = ?')
      .run(scheduleId);
    settleFairness(db, scheduleId);
  });

  return getWeekView(db, schedule.week_start_date);
}

/**
 * 手動換人（拖拉 / Plan X 補位）。
 * 規格 §1：主管具 100% 強制覆寫權，因此衝突只回報不阻擋。
 * @param staffId 傳 null 代表清空該名額
 */
export function overrideAssignment(db, detailId, staffId) {
  const row = repo.findScheduleItem(db, detailId);
  if (!row) throw Object.assign(new Error('班表明細不存在'), { status: 404 });

  const schedule = repo.findScheduleById(db, row.schedule_id);
  const items = repo.itemsById(db);
  let conflicts = [];

  if (staffId != null) {
    const staff = repo.listStaff(db).find((s) => s.staff_id === staffId);
    if (!staff) throw Object.assign(new Error('人員不存在'), { status: 404 });

    const targetItem = items.get(row.item_id);
    if (targetItem) {
      const others = repo.listScheduleItems(db, row.schedule_id).filter((r) => r.detail_id !== detailId);
      const absentSet = new Set(
        absencesForWeek(db, schedule.week_start_date)
          .filter((a) => a.day_of_week)
          .map((a) => `${a.staff_id}:${a.day_of_week}`),
      );
      conflicts = checkConflicts({
        candidate: staff,
        targetItem,
        targetDay: row.day_of_week,
        index: buildBoardIndex(others, items),
        absentSet,
      });
    }
  }

  withTransaction(db, () => {
    repo.updateScheduleItemStaff(db, detailId, staffId);
    settleFairness(db, row.schedule_id);
  });

  return {
    ...getWeekView(db, schedule.week_start_date),
    conflicts: conflicts.map((code) => ({ code, label: CONFLICT_LABEL[code] ?? code })),
  };
}

/** 交換兩個名額上的人員（拖拉互換）。 */
export function swapAssignments(db, detailIdA, detailIdB) {
  const a = repo.findScheduleItem(db, detailIdA);
  const b = repo.findScheduleItem(db, detailIdB);
  if (!a || !b) throw Object.assign(new Error('班表明細不存在'), { status: 404 });
  if (a.schedule_id !== b.schedule_id) throw Object.assign(new Error('兩個名額不屬於同一份班表'), { status: 400 });

  const schedule = repo.findScheduleById(db, a.schedule_id);
  withTransaction(db, () => {
    repo.updateScheduleItemStaff(db, detailIdA, b.staff_id);
    repo.updateScheduleItemStaff(db, detailIdB, a.staff_id);
    settleFairness(db, a.schedule_id);
  });

  return getWeekView(db, schedule.week_start_date);
}

/** Plan X 補位推薦名單。 */
export function planXRecommendations(db, detailId, { limit = 8 } = {}) {
  const row = repo.findScheduleItem(db, detailId);
  if (!row) throw Object.assign(new Error('班表明細不存在'), { status: 404 });

  const schedule = repo.findScheduleById(db, row.schedule_id);
  const items = repo.itemsById(db);
  const targetItem = items.get(row.item_id);
  if (!targetItem) throw Object.assign(new Error('此名額沒有對應點位'), { status: 400 });

  const rows = repo.listScheduleItems(db, row.schedule_id).filter((r) => r.detail_id !== detailId);
  const candidates = recommendReplacements({
    staff: repo.listStaff(db, { activeOnly: true }),
    targetItem,
    targetDay: row.day_of_week,
    rows,
    itemsById: items,
    stats: repo.fairnessMap(db),
    absences: absencesForWeek(db, schedule.week_start_date),
    weekStartDate: schedule.week_start_date,
    excludeStaffId: row.staff_id,
    limit,
  });

  return {
    detail_id: detailId,
    item: targetItem,
    day_of_week: row.day_of_week,
    current_staff_id: row.staff_id,
    candidates: candidates.map((c) => ({
      ...c,
      conflicts: c.conflicts.map((code) => ({ code, label: CONFLICT_LABEL[code] ?? code })),
    })),
  };
}

/** 組出前端單頁所需的完整週檢視。 */
export function getWeekView(db, rawWeek) {
  const schedule = ensureSchedule(db, rawWeek);
  const weekStartDate = schedule.week_start_date;
  const rows = repo.listScheduleItems(db, schedule.schedule_id);

  const dates = Object.fromEntries(WEEK_DAYS.map((d) => [d, dateForDay(weekStartDate, d)]));
  const items = repo.listItems(db);
  const itemMap = new Map(items.map((i) => [i.item_id, i]));

  const openSlots = rows.filter((r) => r.staff_id == null && !r.is_plan_b_standby);
  const warnings = openSlots.map((r) => ({
    code: WARNING.UNDERSTAFFED,
    detail_id: r.detail_id,
    item_id: r.item_id,
    item_name: itemMap.get(r.item_id)?.item_name ?? null,
    day_of_week: r.day_of_week,
  }));

  return {
    schedule: {
      schedule_id: schedule.schedule_id,
      week_start_date: weekStartDate,
      week_end_date: dates[5],
      status: schedule.status,
      generated_at: schedule.generated_at,
      published_at: schedule.published_at,
      dates,
      has_items: rows.length > 0,
    },
    staff: repo.listStaff(db),
    groups: repo.listGroups(db),
    items,
    assignments: rows.filter((r) => !r.is_plan_b_standby),
    standby: rows.filter((r) => r.is_plan_b_standby)
      .sort((a, b) => a.slot_index - b.slot_index)
      .map((r) => ({ detail_id: r.detail_id, staff_id: r.staff_id })),
    absences: absencesForWeek(db, weekStartDate),
    fairness: repo.listFairness(db),
    warnings,
  };
}
