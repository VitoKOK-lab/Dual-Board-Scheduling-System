/* ============================================================
   服務層 —— 生成、覆寫、補位、發布結算
   與伺服器版同一套規則，只是資料改從 STATE 讀寫。
   ============================================================ */

const nowIso = () => new Date().toISOString();

const weekRange = (week) => ({ from: week, to: dateForDay(week, 5) });

function absencesForWeek(week) {
  const { from, to } = weekRange(week);
  const names = new Map(STATE.staff.map((s) => [s.staff_id, s]));
  return ensureWeek(week).absences
    .filter((a) => a.absence_date >= from && a.absence_date <= to)
    .sort((a, b) => a.absence_date.localeCompare(b.absence_date) || a.staff_id - b.staff_id)
    .map((a) => ({
      ...a,
      name: names.get(a.staff_id)?.name ?? '（已刪除）',
      staff_group: names.get(a.staff_id)?.staff_group ?? '',
      role: names.get(a.staff_id)?.role ?? 'APPRENTICE',
      day_of_week: dayOfWeekFor(week, a.absence_date),
    }));
}

/** 一鍵自動排班。重新生成會整批覆蓋該週明細，含手動調整過的部分。 */
function generate(week) {
  const data = ensureWeek(week);
  const plan = generateWeeklyPlan({
    staff: sortedStaff(),
    items: sortedItems(),
    stats: new Map(listFairness().map((f) => [f.staff_id, f])),
    absences: absencesForWeek(week),
    weekStartDate: week,
  });

  data.rows = plan.assignments.map((a) => ({
    detail_id: nextId('detail'),
    staff_id: a.staff_id ?? null,
    item_id: a.item_id ?? null,
    day_of_week: a.day_of_week ?? null,
    is_override: false,
    slot_index: a.slot_index ?? 0,
  }));
  data.generated_at = nowIso();
  settleFairness(week);

  return { ...getWeekView(week), generationWarnings: plan.warnings };
}

/**
 * 公平性結算：先沖銷本週既有帳本，再依「已發布」狀態重新結算。
 * 因此重複發布不會重複累加，撤回發布會完整沖銷。
 */
function settleFairness(week) {
  const data = ensureWeek(week);

  for (const [staffId, delta] of Object.entries(data.ledger ?? {})) {
    const stat = statOf(Number(staffId));
    for (const [field, value] of Object.entries(delta)) {
      stat[field] = Math.max(0, (stat[field] ?? 0) - value);
    }
  }
  data.ledger = {};

  if (data.status !== 'PUBLISHED') return;

  const items = new Map(STATE.items.map((i) => [i.item_id, i]));
  const FIELD = {
    [SHIFT.MORNING]: 'morning_whiteboard_count',
    [SHIFT.FLAG]: 'flag_whiteboard_count',
    [SHIFT.NOON]: 'noon_whiteboard_count',
  };

  for (const row of data.rows) {
    if (row.staff_id == null) continue;

    const delta = data.ledger[row.staff_id] ?? (data.ledger[row.staff_id] = {});
    const bump = (field) => { delta[field] = (delta[field] ?? 0) + 1; };

    const item = items.get(row.item_id);
    if (!item) continue;
    if (item.board_type === BOARD.BLACKBOARD) bump('blackboard_count');
    else if (FIELD[item.shift_type]) bump(FIELD[item.shift_type]);
  }

  for (const [staffId, delta] of Object.entries(data.ledger)) {
    const stat = statOf(Number(staffId));
    for (const [field, value] of Object.entries(delta)) stat[field] = (stat[field] ?? 0) + value;
  }
}

function publish(week) {
  const data = ensureWeek(week);
  data.status = 'PUBLISHED';
  data.published_at = nowIso();
  settleFairness(week);
  return getWeekView(week);
}

function unpublish(week) {
  const data = ensureWeek(week);
  data.status = 'DRAFT';
  data.published_at = null;
  settleFairness(week);
  return getWeekView(week);
}

/** 手動換人。主管具 100% 強制覆寫權，衝突只回報不阻擋。 */
function overrideAssignment(detailId, staffId) {
  const found = locateRow(detailId);
  if (!found) throw new Error('班表明細不存在');
  const { week, row } = found;

  let conflicts = [];
  if (staffId != null) {
    const person = STATE.staff.find((s) => s.staff_id === staffId);
    if (!person) throw new Error('人員不存在');

    const items = new Map(STATE.items.map((i) => [i.item_id, i]));
    const targetItem = items.get(row.item_id);
    if (targetItem) {
      const others = ensureWeek(week).rows.filter((r) => r.detail_id !== detailId);
      const absentSet = new Set(
        absencesForWeek(week).filter((a) => a.day_of_week).map((a) => `${a.staff_id}:${a.day_of_week}`),
      );
      conflicts = checkConflicts({
        candidate: person,
        targetItem,
        targetDay: row.day_of_week,
        index: buildBoardIndex(others, items),
        absentSet,
      });
    }
  }

  row.staff_id = staffId ?? null;
  row.is_override = true;
  settleFairness(week);

  return {
    ...getWeekView(week),
    conflicts: conflicts.map((code) => ({ code, label: CONFLICT_LABEL[code] ?? code })),
  };
}

function swapAssignments(detailIdA, detailIdB) {
  const a = locateRow(detailIdA);
  const b = locateRow(detailIdB);
  if (!a || !b) throw new Error('班表明細不存在');
  if (a.week !== b.week) throw new Error('兩個名額不屬於同一份班表');

  const held = a.row.staff_id;
  a.row.staff_id = b.row.staff_id;
  b.row.staff_id = held;
  a.row.is_override = true;
  b.row.is_override = true;
  settleFairness(a.week);
  return getWeekView(a.week);
}

/** Plan X 補位推薦。 */
function planXRecommendations(detailId, { limit = 8 } = {}) {
  const found = locateRow(detailId);
  if (!found) throw new Error('班表明細不存在');
  const { week, row } = found;

  const items = new Map(STATE.items.map((i) => [i.item_id, i]));
  const targetItem = items.get(row.item_id);
  if (!targetItem) throw new Error('此名額沒有對應點位');

  const candidates = recommendReplacements({
    staff: sortedStaff().filter((s) => s.is_active && s.role === ROLE.MASTER),
    targetItem,
    targetDay: row.day_of_week,
    rows: ensureWeek(week).rows.filter((r) => r.detail_id !== detailId),
    itemsById: items,
    stats: new Map(listFairness().map((f) => [f.staff_id, f])),
    absences: absencesForWeek(week),
    weekStartDate: week,
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

/**
 * 供需摘要：每人每個時段只能站一個點位，
 * 因此單一時段的名額總數不能超過可排班的師傅數。
 */
function buildCapacitySummary(items) {
  const masters = countMasters();
  const demandOf = (shift) => items
    .filter((i) => i.board_type === BOARD.WHITEBOARD && i.shift_type === shift)
    .reduce((sum, i) => sum + i.required_capacity, 0);

  const shifts = WHITEBOARD_SHIFTS.map((shift) => ({
    shift_type: shift,
    label: SHIFT_LABEL[shift] ?? shift,
    slots: demandOf(shift),
    points: items.filter((i) => i.board_type === BOARD.WHITEBOARD && i.shift_type === shift).length,
  }));
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
function getWeekView(week) {
  const data = ensureWeek(week);
  const items = sortedItems();
  const itemMap = new Map(items.map((i) => [i.item_id, i]));
  const dates = Object.fromEntries(WEEK_DAYS.map((d) => [d, dateForDay(week, d)]));

  const warnings = data.rows
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
      schedule_id: week,
      week_start_date: week,
      week_end_date: dates[5],
      status: data.status,
      generated_at: data.generated_at,
      published_at: data.published_at,
      dates,
      has_items: data.rows.length > 0,
    },
    staff: sortedStaff(),
    groups: listGroups(),
    items,
    assignments: data.rows.map(clone),
    absences: absencesForWeek(week),
    fairness: listFairness(),
    published_weeks: countPublishedWeeks(),
    capacity: buildCapacitySummary(items),
    warnings,
  };
}
