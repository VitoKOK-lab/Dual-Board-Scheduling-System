/** 班表服務層：生成、覆寫、補位、公差指派、發布結算。 */

import { BOARD, SHIFT, WARNING, WEEK_DAYS } from '../domain/constants.js';
import { generateWeeklyPlan } from '../domain/scheduler.js';
import { CONFLICT_LABEL, buildBoardIndex, checkConflicts, recommendReplacements } from '../domain/planX.js';
import { dateForDay, mondayOf } from '../domain/week.js';
import { withTransaction } from '../db/index.js';
import * as repo from './repository.js';

const nowIso = () => new Date().toISOString();

const parseFlagDays = (raw) => String(raw ?? '')
  .split(',')
  .map((n) => Number(n))
  .filter((n) => WEEK_DAYS.includes(n))
  .sort();

/** 取得（必要時建立）該週班表主檔。 */
export function ensureSchedule(db, rawWeek) {
  const weekStartDate = mondayOf(rawWeek);
  const existing = repo.findSchedule(db, weekStartDate);
  if (existing) return existing;
  repo.createSchedule(db, weekStartDate);
  return repo.findSchedule(db, weekStartDate);
}

/**
 * 一鍵自動排班。
 * 只重建自動排的部分；主管手動指派的公差會保留下來。
 */
export function generate(db, rawWeek) {
  const schedule = ensureSchedule(db, rawWeek);
  const weekStartDate = schedule.week_start_date;

  const plan = generateWeeklyPlan({
    staff: repo.listStaff(db),
    items: repo.listItems(db),
    stats: repo.fairnessMap(db),
    weekStartDate,
    flagDays: parseFlagDays(schedule.flag_days),
  });

  withTransaction(db, () => {
    repo.deleteGeneratedItems(db, schedule.schedule_id);
    repo.appendScheduleItems(db, schedule.schedule_id, plan.assignments);
    db.prepare('UPDATE weekly_schedules SET generated_at = ? WHERE schedule_id = ?')
      .run(nowIso(), schedule.schedule_id);
    settleFairness(db, schedule.schedule_id);
  });

  return { ...getWeekView(db, weekStartDate), generationWarnings: plan.warnings };
}

/** 設定本週的升旗日。改完要重新排班才會生效。 */
export function setFlagDays(db, rawWeek, days) {
  const schedule = ensureSchedule(db, rawWeek);
  const clean = [...new Set(days.map(Number))].filter((d) => WEEK_DAYS.includes(d)).sort();
  repo.setFlagDays(db, schedule.schedule_id, clean);
  return getWeekView(db, schedule.week_start_date);
}

/**
 * 公平性結算：先沖銷本班表既有帳本，再依「已發布」狀態重新結算。
 * 因此重複發布不會重複累加，撤回發布會完整沖銷。
 */
export function settleFairness(db, scheduleId) {
  const previous = db.prepare('SELECT * FROM fairness_ledger WHERE schedule_id = ?').all(scheduleId);
  const adjust = db.prepare(
    `UPDATE fairness_stats
        SET blackboard_count         = MAX(0, blackboard_count + ?),
            morning_whiteboard_count = MAX(0, morning_whiteboard_count + ?),
            flag_whiteboard_count    = MAX(0, flag_whiteboard_count + ?),
            noon_whiteboard_count    = MAX(0, noon_whiteboard_count + ?),
            special_count            = MAX(0, special_count + ?)
      WHERE staff_id = ?`,
  );

  for (const row of previous) {
    adjust.run(
      -row.blackboard_delta, -row.morning_delta, -row.flag_delta,
      -row.noon_delta, -row.special_delta, row.staff_id,
    );
  }
  db.prepare('DELETE FROM fairness_ledger WHERE schedule_id = ?').run(scheduleId);

  const schedule = repo.findScheduleById(db, scheduleId);
  if (!schedule || schedule.status !== 'PUBLISHED') return;

  const items = repo.itemsById(db);
  const deltas = new Map();
  const bump = (staffId) => {
    if (!deltas.has(staffId)) {
      deltas.set(staffId, { blackboard: 0, morning: 0, flag: 0, noon: 0, special: 0 });
    }
    return deltas.get(staffId);
  };

  const FIELD = {
    [SHIFT.MORNING]: 'morning',
    [SHIFT.FLAG]: 'flag',
    [SHIFT.NOON]: 'noon',
  };

  for (const row of repo.listScheduleItems(db, scheduleId)) {
    if (row.staff_id == null) continue;
    const item = items.get(row.item_id);
    if (!item) continue;

    const d = bump(row.staff_id);
    if (item.board_type === BOARD.SPECIAL) d.special += 1;
    else if (item.board_type === BOARD.BLACKBOARD) d.blackboard += 1;
    else if (FIELD[item.shift_type]) d[FIELD[item.shift_type]] += 1;
  }

  const insertLedger = db.prepare(
    `INSERT INTO fairness_ledger
       (schedule_id, staff_id, blackboard_delta, morning_delta, flag_delta, noon_delta, special_delta, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ensureStat = db.prepare('INSERT OR IGNORE INTO fairness_stats (staff_id) VALUES (?)');
  const stamp = nowIso();

  for (const [staffId, d] of deltas) {
    ensureStat.run(staffId);
    insertLedger.run(scheduleId, staffId, d.blackboard, d.morning, d.flag, d.noon, d.special, stamp);
    adjust.run(d.blackboard, d.morning, d.flag, d.noon, d.special, staffId);
  }
}

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
 * 手動換人。
 * 規格 §1：主管具 100% 強制覆寫權，因此衝突只回報不阻擋。
 */
export function overrideAssignment(db, detailId, staffId) {
  const row = repo.findScheduleItem(db, detailId);
  if (!row) throw Object.assign(new Error('班表明細不存在'), { status: 404 });

  const schedule = repo.findScheduleById(db, row.schedule_id);
  const items = repo.itemsById(db);
  let conflicts = [];

  if (staffId != null) {
    const person = repo.listStaff(db).find((s) => s.staff_id === staffId);
    if (!person) throw Object.assign(new Error('人員不存在'), { status: 404 });

    const targetItem = items.get(row.item_id);
    if (targetItem) {
      const others = repo.listScheduleItems(db, row.schedule_id).filter((r) => r.detail_id !== detailId);
      conflicts = checkConflicts({
        candidate: person,
        targetItem,
        targetDay: row.day_of_week,
        index: buildBoardIndex(others, items),
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

/** 公差：主管手動把某個特殊任務指派給某人。 */
export function assignSpecial(db, rawWeek, { staffId, itemId, dayOfWeek = null, note = null }) {
  const schedule = ensureSchedule(db, rawWeek);

  const item = repo.findItem(db, itemId);
  if (!item) throw Object.assign(new Error('任務不存在'), { status: 404 });
  if (item.board_type !== BOARD.SPECIAL) throw Object.assign(new Error('這不是公差任務'), { status: 400 });

  const person = repo.listStaff(db).find((s) => s.staff_id === staffId);
  if (!person) throw Object.assign(new Error('人員不存在'), { status: 404 });
  if (dayOfWeek != null && !WEEK_DAYS.includes(dayOfWeek)) {
    throw Object.assign(new Error('day_of_week 需為 1~5 或不填'), { status: 400 });
  }

  withTransaction(db, () => {
    repo.createScheduleItem(db, schedule.schedule_id, { staffId, itemId, dayOfWeek, note });
    settleFairness(db, schedule.schedule_id);
  });
  return getWeekView(db, schedule.week_start_date);
}

export function removeSpecial(db, detailId) {
  const row = repo.findScheduleItem(db, detailId);
  if (!row) throw Object.assign(new Error('班表明細不存在'), { status: 404 });

  const schedule = repo.findScheduleById(db, row.schedule_id);
  withTransaction(db, () => {
    repo.deleteScheduleItem(db, detailId);
    settleFairness(db, row.schedule_id);
  });
  return getWeekView(db, schedule.week_start_date);
}

/** 換人推薦名單。 */
export function planXRecommendations(db, detailId, { limit = 8 } = {}) {
  const row = repo.findScheduleItem(db, detailId);
  if (!row) throw Object.assign(new Error('班表明細不存在'), { status: 404 });

  const items = repo.itemsById(db);
  const targetItem = items.get(row.item_id);
  if (!targetItem) throw Object.assign(new Error('此名額沒有對應點位'), { status: 400 });

  const candidates = recommendReplacements({
    staff: repo.listStaff(db, { activeOnly: true, mastersOnly: true }),
    targetItem,
    targetDay: row.day_of_week,
    rows: repo.listScheduleItems(db, row.schedule_id).filter((r) => r.detail_id !== detailId),
    itemsById: items,
    stats: repo.fairnessMap(db),
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

/** 供需摘要：白板依週指派，所以上限是「點位數 ≤ 可排班師傅數」。 */
function buildCapacitySummary(db, items) {
  const masters = repo.countSchedulableMasters(db);
  const pointsOf = (shift) => items
    .filter((i) => i.board_type === BOARD.WHITEBOARD && i.shift_type === shift);
  const describe = (shift, label, weekly) => {
    const list = pointsOf(shift);
    return {
      shift_type: shift,
      label,
      weekly,
      points: list.length,
      // 一個點位可以設定站好幾個人，名額數才是真正要動用的人數
      slots: list.reduce((sum, i) => sum + Math.max(1, i.required_capacity ?? 1), 0),
    };
  };

  const shifts = [
    describe(SHIFT.MORNING, '早修', true),
    describe(SHIFT.NOON, '午休', true),
    describe(SHIFT.FLAG, '升旗', false),
  ];

  const peak = Math.max(0, ...shifts.map((s) => s.slots));
  return {
    masters,
    shifts,
    peak_slots: peak,
    headroom: masters - peak,
    feasible: peak <= masters,
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

  const warnings = rows
    .filter((r) => r.staff_id == null)
    .map((r) => ({
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
      flag_days: parseFlagDays(schedule.flag_days),
      dates,
      has_items: rows.length > 0,
    },
    staff: repo.listStaff(db),
    groups: repo.listGroups(db),
    items,
    assignments: rows,
    fairness: repo.listFairness(db),
    published_weeks: repo.countPublishedWeeks(db),
    capacity: buildCapacitySummary(db, items),
    warnings,
  };
}
