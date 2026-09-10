/** 資料存取層：把 SQL 集中在此，服務層只處理商業邏輯。 */

const STAFF_ORDER = 'ORDER BY sort_order, staff_id';

export function listStaff(db, { activeOnly = false } = {}) {
  const where = activeOnly ? 'WHERE is_active = 1' : '';
  return db.prepare(`SELECT staff_id, name, staff_group, is_active FROM staff ${where} ${STAFF_ORDER}`)
    .all().map((r) => ({ ...r, is_active: !!r.is_active }));
}

/** 名冊中出現過的組別，依名冊順序。 */
export function listGroups(db) {
  return db.prepare(
    `SELECT staff_group AS name, COUNT(*) AS total,
            SUM(is_active) AS active_total, MIN(sort_order) AS ord
       FROM staff WHERE staff_group <> '' GROUP BY staff_group ORDER BY ord`,
  ).all().map(({ name, total, active_total: activeTotal }) => ({ name, total, active_total: activeTotal }));
}

export function createStaff(db, name, staffGroup = '') {
  const nextOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM staff').get().n;
  const info = db.prepare('INSERT INTO staff (name, staff_group, sort_order) VALUES (?, ?, ?)')
    .run(name, staffGroup, nextOrder);
  const staffId = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO fairness_stats (staff_id) VALUES (?)').run(staffId);
  return staffId;
}

export function setStaffActive(db, staffId, isActive) {
  db.prepare('UPDATE staff SET is_active = ? WHERE staff_id = ?').run(isActive ? 1 : 0, staffId);
}

export function listItems(db) {
  return db.prepare(
    `SELECT item_id, board_type, shift_type, item_name, required_capacity, sort_order
       FROM location_tasks ORDER BY board_type, shift_type, sort_order, item_id`,
  ).all();
}

export function itemsById(db) {
  return new Map(listItems(db).map((i) => [i.item_id, i]));
}

export function listFairness(db) {
  return db.prepare(
    `SELECT s.staff_id, s.name, s.staff_group, s.is_active,
            COALESCE(f.blackboard_count, 0)         AS blackboard_count,
            COALESCE(f.morning_whiteboard_count, 0) AS morning_whiteboard_count,
            COALESCE(f.noon_whiteboard_count, 0)    AS noon_whiteboard_count
       FROM staff s LEFT JOIN fairness_stats f ON f.staff_id = s.staff_id
      ORDER BY s.sort_order, s.staff_id`,
  ).all().map((r) => ({ ...r, is_active: !!r.is_active }));
}

export function fairnessMap(db) {
  return new Map(listFairness(db).map((r) => [r.staff_id, r]));
}

export function findSchedule(db, weekStartDate) {
  return db.prepare('SELECT * FROM weekly_schedules WHERE week_start_date = ?').get(weekStartDate) ?? null;
}

export function findScheduleById(db, scheduleId) {
  return db.prepare('SELECT * FROM weekly_schedules WHERE schedule_id = ?').get(scheduleId) ?? null;
}

export function createSchedule(db, weekStartDate) {
  const info = db.prepare(
    'INSERT INTO weekly_schedules (week_start_date, status) VALUES (?, \'DRAFT\')',
  ).run(weekStartDate);
  return Number(info.lastInsertRowid);
}

export function listScheduleItems(db, scheduleId) {
  return db.prepare(
    `SELECT detail_id, schedule_id, staff_id, item_id, day_of_week,
            is_plan_b_standby, is_override, slot_index
       FROM schedule_items WHERE schedule_id = ?
      ORDER BY day_of_week, item_id, slot_index, detail_id`,
  ).all(scheduleId).map((r) => ({
    ...r,
    is_plan_b_standby: !!r.is_plan_b_standby,
    is_override: !!r.is_override,
  }));
}

export function findScheduleItem(db, detailId) {
  const row = db.prepare('SELECT * FROM schedule_items WHERE detail_id = ?').get(detailId);
  if (!row) return null;
  return { ...row, is_plan_b_standby: !!row.is_plan_b_standby, is_override: !!row.is_override };
}

export function replaceScheduleItems(db, scheduleId, assignments) {
  db.prepare('DELETE FROM schedule_items WHERE schedule_id = ?').run(scheduleId);
  const insert = db.prepare(
    `INSERT INTO schedule_items
       (schedule_id, staff_id, item_id, day_of_week, is_plan_b_standby, is_override, slot_index)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const a of assignments) {
    insert.run(
      scheduleId,
      a.staff_id ?? null,
      a.item_id ?? null,
      a.day_of_week ?? null,
      a.is_plan_b_standby ? 1 : 0,
      a.is_override ? 1 : 0,
      a.slot_index ?? 0,
    );
  }
}

export function updateScheduleItemStaff(db, detailId, staffId, { isOverride = true } = {}) {
  db.prepare('UPDATE schedule_items SET staff_id = ?, is_override = ? WHERE detail_id = ?')
    .run(staffId ?? null, isOverride ? 1 : 0, detailId);
}

export function listAbsences(db, fromDate, toDate) {
  return db.prepare(
    `SELECT a.absence_id, a.staff_id, s.name, s.staff_group, a.absence_date, a.absence_type, a.note
       FROM staff_absences a JOIN staff s ON s.staff_id = a.staff_id
      WHERE a.absence_date BETWEEN ? AND ?
      ORDER BY a.absence_date, a.staff_id`,
  ).all(fromDate, toDate);
}

export function createAbsence(db, { staffId, absenceDate, absenceType = 'OFFICIAL', note = null }) {
  db.prepare(
    `INSERT INTO staff_absences (staff_id, absence_date, absence_type, note)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (staff_id, absence_date)
     DO UPDATE SET absence_type = excluded.absence_type, note = excluded.note`,
  ).run(staffId, absenceDate, absenceType, note);
}

export function deleteAbsence(db, absenceId) {
  db.prepare('DELETE FROM staff_absences WHERE absence_id = ?').run(absenceId);
}
