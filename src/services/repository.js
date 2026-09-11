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
            COALESCE(f.special_count, 0)            AS special_count
       FROM staff s LEFT JOIN fairness_stats f ON f.staff_id = s.staff_id
      ORDER BY s.sort_order, s.staff_id`,
  ).all().map((r) => ({ ...r, is_active: !!r.is_active }));
}

export function fairnessMap(db) {
  return new Map(listFairness(db).map((r) => [r.staff_id, r]));
}

/** 已發布的週數，供統計頁換算每週平均。 */
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
            is_override, slot_index, note
       FROM schedule_items WHERE schedule_id = ?
      ORDER BY day_of_week, item_id, slot_index, detail_id`,
  ).all(scheduleId).map((r) => ({ ...r, is_override: !!r.is_override }));
}

export function findScheduleItem(db, detailId) {
  const row = db.prepare('SELECT * FROM schedule_items WHERE detail_id = ?').get(detailId);
  if (!row) return null;
  return { ...row, is_override: !!row.is_override };
}

export function appendScheduleItems(db, scheduleId, assignments) {
  const insert = db.prepare(
    `INSERT INTO schedule_items
       (schedule_id, staff_id, item_id, day_of_week, is_override, slot_index, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const a of assignments) {
    insert.run(
      scheduleId,
      a.staff_id ?? null,
      a.item_id ?? null,
      a.day_of_week ?? null,
      a.is_override ? 1 : 0,
      a.slot_index ?? 0,
      a.note ?? null,
    );
  }
}

/** 新增一筆公差指派（主管手動）。 */
export function createScheduleItem(db, scheduleId, { staffId, itemId, dayOfWeek = null, note = null }) {
  const info = db.prepare(
    `INSERT INTO schedule_items (schedule_id, staff_id, item_id, day_of_week, is_override, slot_index, note)
     VALUES (?, ?, ?, ?, 1, 0, ?)`,
  ).run(scheduleId, staffId, itemId, dayOfWeek, note);
  return Number(info.lastInsertRowid);
}

export function deleteScheduleItem(db, detailId) {
  db.prepare('DELETE FROM schedule_items WHERE detail_id = ?').run(detailId);
}

/** 只刪掉自動排班會重建的列，保留主管手動指派的公差。 */
export function deleteGeneratedItems(db, scheduleId) {
  db.prepare(
    `DELETE FROM schedule_items
      WHERE schedule_id = ?
        AND item_id IN (SELECT item_id FROM location_tasks WHERE board_type <> 'SPECIAL')`,
  ).run(scheduleId);
}

export function setFlagDays(db, scheduleId, days) {
  db.prepare('UPDATE weekly_schedules SET flag_days = ? WHERE schedule_id = ?')
    .run(days.join(','), scheduleId);
}

export function updateScheduleItemStaff(db, detailId, staffId, { isOverride = true } = {}) {
  db.prepare('UPDATE schedule_items SET staff_id = ?, is_override = ? WHERE detail_id = ?')
    .run(staffId ?? null, isOverride ? 1 : 0, detailId);
}


/* ---------- 備份 ---------- */

export const BACKUP_FORMAT = 'dual-board-backup';
export const BACKUP_VERSION = 1;

/** 匯出整個資料庫，格式與單頁版相同，兩邊的備份檔可互通。 */
export function exportAll(db) {
  const weeks = {};
  for (const schedule of db.prepare('SELECT * FROM weekly_schedules').all()) {
    const ledger = {};
    for (const row of db.prepare('SELECT * FROM fairness_ledger WHERE schedule_id = ?').all(schedule.schedule_id)) {
      const delta = {};
      for (const [column, field] of Object.entries({
        blackboard_delta: 'blackboard_count',
        morning_delta: 'morning_whiteboard_count',
        flag_delta: 'flag_whiteboard_count',
        noon_delta: 'noon_whiteboard_count',
        special_delta: 'special_count',
      })) {
        if (row[column]) delta[field] = row[column];
      }
      if (Object.keys(delta).length > 0) ledger[row.staff_id] = delta;
    }

    const week = schedule.week_start_date;
    weeks[week] = {
      week_start_date: week,
      status: schedule.status,
      generated_at: schedule.generated_at,
      published_at: schedule.published_at,
      // 備份裡一律用陣列，跟瀏覽器版的格式對齊
      flag_days: String(schedule.flag_days ?? '').split(',').map(Number).filter((n) => n >= 1 && n <= 5),
      rows: listScheduleItems(db, schedule.schedule_id).map((r) => ({
        detail_id: r.detail_id,
        staff_id: r.staff_id,
        item_id: r.item_id,
        day_of_week: r.day_of_week,
        is_override: r.is_override,
        slot_index: r.slot_index,
        note: r.note ?? null,
      })),
      ledger,
    };
  }

  const fairness = {};
  for (const row of listFairness(db)) {
    fairness[row.staff_id] = {
      blackboard_count: row.blackboard_count,
      morning_whiteboard_count: row.morning_whiteboard_count,
      flag_whiteboard_count: row.flag_whiteboard_count,
      noon_whiteboard_count: row.noon_whiteboard_count,
      special_count: row.special_count,
    };
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    staff: listStaff(db).map((s) => ({ ...s, is_active: s.is_active ? 1 : 0 })),
    items: listItems(db),
    fairness,
    weeks,
  };
}

/** 匯入會整份取代現有資料，不做合併——合併規則沒有正確答案，覆蓋才可預期。 */
export function importAll(db, data) {
  if (data?.format !== BACKUP_FORMAT) throw Object.assign(new Error('這不是雙板排班的備份檔'), { status: 400 });
  if (!Array.isArray(data.staff) || !Array.isArray(data.items)) {
    throw Object.assign(new Error('備份檔內容不完整'), { status: 400 });
  }

  for (const table of ['fairness_ledger', 'schedule_items', 'weekly_schedules',
    'fairness_stats', 'location_tasks', 'staff']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }

  const insertStaff = db.prepare(
    'INSERT INTO staff (staff_id, name, staff_group, role, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const [i, s] of data.staff.entries()) {
    insertStaff.run(s.staff_id, s.name, s.staff_group ?? '', s.role ?? 'APPRENTICE',
      s.is_active === false || s.is_active === 0 ? 0 : 1, s.sort_order ?? i + 1);
  }

  const insertItem = db.prepare(
    `INSERT INTO location_tasks (item_id, board_type, shift_type, item_name, required_capacity, zone, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [i, it] of data.items.entries()) {
    insertItem.run(it.item_id, it.board_type, it.shift_type, it.item_name,
      it.required_capacity ?? 1, it.zone ?? '', it.sort_order ?? (i + 1) * 10);
  }

  const insertStat = db.prepare(
    `INSERT INTO fairness_stats (staff_id, blackboard_count, morning_whiteboard_count,
       flag_whiteboard_count, noon_whiteboard_count, special_count) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const s of data.staff) {
    const f = data.fairness?.[s.staff_id] ?? {};
    insertStat.run(s.staff_id, f.blackboard_count ?? 0, f.morning_whiteboard_count ?? 0,
      f.flag_whiteboard_count ?? 0, f.noon_whiteboard_count ?? 0, f.special_count ?? 0);
  }

  const insertSchedule = db.prepare(
    `INSERT INTO weekly_schedules (week_start_date, status, generated_at, published_at, flag_days)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertRow = db.prepare(
    `INSERT INTO schedule_items
       (schedule_id, staff_id, item_id, day_of_week, is_override, slot_index, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // 帳本一定要跟著還原，否則之後撤回發布會沖銷不掉已累加的次數
  const insertLedger = db.prepare(
    `INSERT INTO fairness_ledger (schedule_id, staff_id, blackboard_delta, morning_delta,
       flag_delta, noon_delta, special_delta, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // 備份可能來自瀏覽器版（陣列）或舊版伺服器（逗號字串），兩種都收
  const flagDaysText = (value) => (Array.isArray(value) ? value.join(',') : String(value ?? ''));

  for (const [week, data_] of Object.entries(data.weeks ?? {})) {
    const info = insertSchedule.run(week, data_.status ?? 'DRAFT',
      data_.generated_at ?? null, data_.published_at ?? null, flagDaysText(data_.flag_days));
    const scheduleId = Number(info.lastInsertRowid);

    for (const r of data_.rows ?? []) {
      insertRow.run(scheduleId, r.staff_id ?? null, r.item_id ?? null, r.day_of_week ?? null,
        r.is_override ? 1 : 0, r.slot_index ?? 0, r.note ?? null);
    }
    for (const [staffId, delta] of Object.entries(data_.ledger ?? {})) {
      insertLedger.run(scheduleId, Number(staffId),
        delta.blackboard_count ?? 0, delta.morning_whiteboard_count ?? 0,
        delta.flag_whiteboard_count ?? 0, delta.noon_whiteboard_count ?? 0,
        delta.special_count ?? 0, data_.published_at ?? new Date().toISOString());
    }
  }

  return {
    staff: data.staff.length,
    items: data.items.length,
    weeks: Object.keys(data.weeks ?? {}).length,
  };
}
