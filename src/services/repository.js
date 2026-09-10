/** 資料存取層：把 SQL 集中在此，服務層只處理商業邏輯。 */

const STAFF_ORDER = 'ORDER BY sort_order, staff_id';

export function listStaff(db, { activeOnly = false, mastersOnly = false } = {}) {
  const clauses = [];
  if (activeOnly) clauses.push('is_active = 1');
  if (mastersOnly) clauses.push("role = 'MASTER'");
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT staff_id, name, staff_group, role, is_active FROM staff ${where} ${STAFF_ORDER}`)
    .all().map((r) => ({ ...r, is_active: !!r.is_active }));
}

/** 名冊中出現過的組別，依名冊順序。 */
export function listGroups(db) {
  return db.prepare(
    `SELECT staff_group AS name, COUNT(*) AS total,
            SUM(is_active) AS active_total,
            SUM(CASE WHEN role = 'MASTER' THEN 1 ELSE 0 END) AS master_total,
            MIN(sort_order) AS ord
       FROM staff WHERE staff_group <> '' GROUP BY staff_group ORDER BY ord`,
  ).all().map(({ name, total, active_total: activeTotal, master_total: masterTotal }) => ({
    name, total, active_total: activeTotal, master_total: masterTotal,
  }));
}

/** 可排班的師傅數；決定單一時段名額總數的上限。 */
export function countSchedulableMasters(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM staff WHERE is_active = 1 AND role = 'MASTER'").get().n;
}

export function setStaffRole(db, staffId, role) {
  db.prepare('UPDATE staff SET role = ? WHERE staff_id = ?').run(role, staffId);
}

export function createStaff(db, name, staffGroup = '', role = 'APPRENTICE') {
  const nextOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM staff').get().n;
  const info = db.prepare('INSERT INTO staff (name, staff_group, role, sort_order) VALUES (?, ?, ?, ?)')
    .run(name, staffGroup, role, nextOrder);
  const staffId = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO fairness_stats (staff_id) VALUES (?)').run(staffId);
  return staffId;
}

export function renameStaff(db, staffId, name) {
  db.prepare('UPDATE staff SET name = ? WHERE staff_id = ?').run(name, staffId);
}

export function setStaffActive(db, staffId, isActive) {
  db.prepare('UPDATE staff SET is_active = ? WHERE staff_id = ?').run(isActive ? 1 : 0, staffId);
}

export function listItems(db) {
  return db.prepare(
    `SELECT item_id, board_type, shift_type, item_name, required_capacity, zone, sort_order
       FROM location_tasks ORDER BY board_type, shift_type, sort_order, item_id`,
  ).all();
}

export function findItem(db, itemId) {
  return db.prepare(
    `SELECT item_id, board_type, shift_type, item_name, required_capacity, zone, sort_order
       FROM location_tasks WHERE item_id = ?`,
  ).get(itemId) ?? null;
}

export function createItem(db, { boardType, shiftType, itemName, requiredCapacity = 1, zone = '' }) {
  const nextOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM location_tasks WHERE board_type = ? AND shift_type = ?',
  ).get(boardType, shiftType).n;

  const info = db.prepare(
    `INSERT INTO location_tasks (board_type, shift_type, item_name, required_capacity, zone, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(boardType, shiftType, itemName, requiredCapacity, zone, nextOrder);
  return Number(info.lastInsertRowid);
}

export function updateItem(db, itemId, patch) {
  const columns = {
    item_name: patch.itemName,
    required_capacity: patch.requiredCapacity,
    zone: patch.zone,
    sort_order: patch.sortOrder,
  };
  const entries = Object.entries(columns).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;

  const setSql = entries.map(([col]) => `${col} = ?`).join(', ');
  db.prepare(`UPDATE location_tasks SET ${setSql} WHERE item_id = ?`)
    .run(...entries.map(([, v]) => v), itemId);
}

/** 刪除點位會連帶刪掉所有班表上引用它的名額（ON DELETE CASCADE）。 */
export function deleteItem(db, itemId) {
  db.prepare('DELETE FROM location_tasks WHERE item_id = ?').run(itemId);
}

/** 刪除人員：班表上的名額會變成空缺（ON DELETE SET NULL），統計與公差一併移除。 */
export function deleteStaff(db, staffId) {
  db.prepare('DELETE FROM staff WHERE staff_id = ?').run(staffId);
}

/** 該人員目前在幾個名額上；刪除前用來提醒主管。 */
export function countStaffAssignments(db, staffId) {
  return db.prepare('SELECT COUNT(*) AS n FROM schedule_items WHERE staff_id = ?').get(staffId).n;
}

export function countItemAssignments(db, itemId) {
  return db.prepare('SELECT COUNT(*) AS n FROM schedule_items WHERE item_id = ?').get(itemId).n;
}

export function itemsById(db) {
  return new Map(listItems(db).map((i) => [i.item_id, i]));
}

export function listFairness(db) {
  return db.prepare(
    `SELECT s.staff_id, s.name, s.staff_group, s.role, s.is_active,
            COALESCE(f.blackboard_count, 0)         AS blackboard_count,
            COALESCE(f.morning_whiteboard_count, 0) AS morning_whiteboard_count,
            COALESCE(f.flag_whiteboard_count, 0)    AS flag_whiteboard_count,
            COALESCE(f.noon_whiteboard_count, 0)    AS noon_whiteboard_count,
            COALESCE(f.standby_count, 0)            AS standby_count
       FROM staff s LEFT JOIN fairness_stats f ON f.staff_id = s.staff_id
      ORDER BY s.sort_order, s.staff_id`,
  ).all().map((r) => ({ ...r, is_active: !!r.is_active }));
}

export function fairnessMap(db) {
  return new Map(listFairness(db).map((r) => [r.staff_id, r]));
}

/** 已發布的週數；用於把預備隊的待命週折算回公平性比較。 */
export function countPublishedWeeks(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM weekly_schedules WHERE status = 'PUBLISHED'").get().n;
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
    `SELECT a.absence_id, a.staff_id, s.name, s.staff_group, s.role, a.absence_date, a.absence_type, a.note
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
