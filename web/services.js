/* ============================================================
   服務層 —— 生成、覆寫、補位、發布結算
   與伺服器版同一套規則，只是資料改從 STATE 讀寫。
   ============================================================ */

const nowIso = () => new Date().toISOString();

const isSpecial = (row) => STATE.items.find((i) => i.item_id === row.item_id)?.board_type === BOARD.SPECIAL;

/**
 * 一鍵自動排班。
 * 只重建自動排的部分；主管手動指派的公差會原封保留。
 */
function generate(week) {
  const data = ensureWeek(week);
  const plan = generateWeeklyPlan({
    staff: sortedStaff(),
    items: sortedItems(),
    stats: new Map(listFairness().map((f) => [f.staff_id, f])),
    weekStartDate: week,
    flagDays: data.flag_days ?? [],
  });

  const kept = data.rows.filter(isSpecial);
  data.rows = [...kept, ...plan.assignments.map((a) => ({
    detail_id: nextId('detail'),
    staff_id: a.staff_id ?? null,
    item_id: a.item_id ?? null,
    day_of_week: a.day_of_week ?? null,
    is_override: false,
    slot_index: a.slot_index ?? 0,
  }))];
  data.generated_at = nowIso();
  settleFairness(week);

  return { ...getWeekView(week), generationWarnings: plan.warnings };
}

/** 設定本週的升旗日。改完要重新排班才會生效。 */
function setFlagDays(week, days) {
  const data = ensureWeek(week);
  data.flag_days = [...new Set(days.map(Number))].filter((d) => WEEK_DAYS.includes(d)).sort();
  return getWeekView(week);
}

/**
 * 公差：主管手動把某個特殊任務指派給某人。
 * 只有「誰做了哪件任務」，沒有時間、沒有排班邏輯；作用就是計入公差次數。
 */
function assignSpecial(week, { staffId, itemId }) {
  const data = ensureWeek(week);

  const item = STATE.items.find((i) => i.item_id === itemId);
  if (!item) throw new Error('任務不存在');
  if (item.board_type !== BOARD.SPECIAL) throw new Error('這不是公差任務');
  if (!STATE.staff.some((s) => s.staff_id === staffId)) throw new Error('人員不存在');

  data.rows.push({
    detail_id: nextId('detail'),
    staff_id: staffId,
    item_id: itemId,
    day_of_week: null,
    is_override: true,
    slot_index: data.rows.filter((r) => r.item_id === itemId).length,
  });
  settleFairness(week);
  return getWeekView(week);
}

function removeSpecial(detailId) {
  const found = locateRow(detailId);
  if (!found) throw new Error('班表明細不存在');
  const data = ensureWeek(found.week);
  data.rows = data.rows.filter((r) => r.detail_id !== detailId);
  settleFairness(found.week);
  return getWeekView(found.week);
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
    if (item.board_type === BOARD.SPECIAL) bump('special_count');
    else if (item.board_type === BOARD.BLACKBOARD) bump('blackboard_count');
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

/**
 * 手動換人。主管說了算，不阻擋也不回報衝突。
 *
 * 白板一個人同一時段只會站一個地方，所以把人放進白板名額時，
 * 自動把他原本在同一時段的舊名額清空——以新的為準。
 * 黑板不做這件事：同一人本來就可能同時擔任兩項黑板職務。
 */
function overrideAssignment(detailId, staffId) {
  const found = locateRow(detailId);
  if (!found) throw new Error('班表明細不存在');
  const { week, row } = found;

  if (staffId != null && !STATE.staff.some((s) => s.staff_id === staffId)) throw new Error('人員不存在');

  const items = new Map(STATE.items.map((i) => [i.item_id, i]));
  const targetItem = items.get(row.item_id);

  if (staffId != null && targetItem?.board_type === BOARD.WHITEBOARD) {
    for (const other of ensureWeek(week).rows) {
      if (other.detail_id === detailId || other.staff_id !== staffId) continue;
      const item = items.get(other.item_id);
      if (!item || item.board_type !== BOARD.WHITEBOARD) continue;
      if (item.shift_type !== targetItem.shift_type) continue;
      // 升旗一天一輪，只有同一天才算重複；早修午休依週指派，同時段就算重複
      if (targetItem.shift_type === SHIFT.FLAG && other.day_of_week !== row.day_of_week) continue;
      other.staff_id = null;
      other.is_override = true;
    }
  }

  row.staff_id = staffId ?? null;
  row.is_override = true;
  settleFairness(week);

  return getWeekView(week);
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

/** 供需摘要：白板依週指派，所以上限是「點位數 ≤ 可排班師傅數」。 */
function buildCapacitySummary(items) {
  const masters = countMasters();
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
      flag_days: [...(data.flag_days ?? [])],
      dates,
      has_items: data.rows.length > 0,
    },
    staff: sortedStaff(),
    groups: listGroups(),
    items,
    assignments: data.rows.map(clone),
    fairness: listFairness(),
    published_weeks: countPublishedWeeks(),
    capacity: buildCapacitySummary(items),
    warnings,
  };
}
