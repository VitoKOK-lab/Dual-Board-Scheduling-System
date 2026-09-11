/**
 * Plan X 動態補位 —— 規格 §2.3。
 *
 * 主管點擊名牌換人時，依當前負擔由輕到重推薦可用的師傅。
 * 同時提供覆寫衝突檢查：規格 §1 明訂主管具 100% 強制覆寫權，
 * 因此本模組只「回報衝突」，不阻擋指派。
 */

import { BOARD, ROLE, SHIFT, WEEK_DAYS, WHITEBOARD_SHIFTS } from './constants.js';
import { DIMENSION, DIMENSION_COLUMN } from './fairness.js';
import { dayOfWeekFor } from './week.js';

export const CONFLICT = {
  INACTIVE: 'INACTIVE',                 // 人員已停用
  ABSENT: 'ABSENT',                     // 當日有公差 / 請假
  DUPLICATE_SHIFT: 'DUPLICATE_SHIFT',   // 當日同時段已有其他點位
  SAME_LOCATION: 'SAME_LOCATION',       // 當日已站過同一個點位
  BLACKBOARD_DOUBLE: 'BLACKBOARD_DOUBLE', // 當日已有其他黑板任務
  ALL_WEEK_HELD: 'ALL_WEEK_HELD',       // 已擔任全週職務
  ALREADY_HERE: 'ALREADY_HERE',         // 已在同一點位
  APPRENTICE: 'APPRENTICE',             // 徒弟尚未升級為師傅，不能排班
};

export const CONFLICT_LABEL = {
  [CONFLICT.INACTIVE]: '人員已停用',
  [CONFLICT.ABSENT]: '當日有公差／請假',
  [CONFLICT.DUPLICATE_SHIFT]: '當日同時段已有點位',
  [CONFLICT.SAME_LOCATION]: '當日已站過同一點位',
  [CONFLICT.BLACKBOARD_DOUBLE]: '當日已有其他黑板任務',
  [CONFLICT.ALL_WEEK_HELD]: '已擔任全週職務',
  [CONFLICT.ALREADY_HERE]: '已在同一點位',
  [CONFLICT.APPRENTICE]: '徒弟，尚未升級為師傅',
};

function shiftOf(item) {
  if (!item) return null;
  if (item.board_type === BOARD.WHITEBOARD) return item.shift_type;
  return item.shift_type === SHIFT.ALL_WEEK ? SHIFT.ALL_WEEK : SHIFT.DAILY;
}

/**
 * 把班表列轉成查詢索引。
 * @param rows 班表明細（含 staff_id / item_id / day_of_week）
 * @param itemsById Map<item_id, location_task>
 */
export function buildBoardIndex(rows, itemsById) {
  const index = {
    onShift: new Map(),       // `${shift}:${day}` -> Set<staffId>
    spots: new Map(),         // day -> Map<staffId, Set<item_name>>
    blackboardDaily: new Map(), // day -> Map<staffId, Set<item_id>>
    allWeek: new Map(),       // staffId -> Set<item_id>
    occupancy: new Map(),     // item_id -> Map<day|'ALL', Set<staffId>>
    weekAssigned: new Map(),  // staffId -> 本週被指派次數
  };
  for (const d of WEEK_DAYS) {
    index.spots.set(d, new Map());
    index.blackboardDaily.set(d, new Map());
    for (const shift of WHITEBOARD_SHIFTS) index.onShift.set(`${shift}:${d}`, new Set());
  }

  const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  };

  for (const row of rows) {
    if (row.staff_id == null) continue;

    const item = itemsById.get(row.item_id);
    if (!item) continue;

    index.weekAssigned.set(row.staff_id, (index.weekAssigned.get(row.staff_id) ?? 0) + 1);

    const dayKey = row.day_of_week ?? 'ALL';
    if (!index.occupancy.has(row.item_id)) index.occupancy.set(row.item_id, new Map());
    push(index.occupancy.get(row.item_id), dayKey, row.staff_id);

    const shift = shiftOf(item);
    if (WHITEBOARD_SHIFTS.includes(shift)) {
      index.onShift.get(`${shift}:${row.day_of_week}`)?.add(row.staff_id);
      push(index.spots.get(row.day_of_week), row.staff_id, item.item_name);
    } else if (shift === SHIFT.DAILY) {
      push(index.blackboardDaily.get(row.day_of_week), row.staff_id, item.item_id);
    } else if (shift === SHIFT.ALL_WEEK) {
      push(index.allWeek, row.staff_id, item.item_id);
    }
  }

  return index;
}

function absentDays(absences, weekStartDate) {
  const set = new Set();
  for (const a of absences ?? []) {
    const day = a.day_of_week ?? dayOfWeekFor(weekStartDate, a.absence_date);
    if (day) set.add(`${a.staff_id}:${day}`);
  }
  return set;
}

/**
 * 檢查把 candidate 放進 targetItem/targetDay 會踩到哪些限制。
 * @returns {string[]} 衝突代碼陣列（空陣列代表完全合規）
 */
export function checkConflicts({
  candidate, targetItem, targetDay, index, absentSet,
}) {
  const conflicts = [];
  const id = candidate.staff_id;

  if (!candidate.is_active) conflicts.push(CONFLICT.INACTIVE);
  if (candidate.role !== ROLE.MASTER) conflicts.push(CONFLICT.APPRENTICE);
  if (targetDay && absentSet.has(`${id}:${targetDay}`)) conflicts.push(CONFLICT.ABSENT);
  if (!targetDay && WEEK_DAYS.some((d) => absentSet.has(`${id}:${d}`))) conflicts.push(CONFLICT.ABSENT);

  const occupants = index.occupancy.get(targetItem.item_id)?.get(targetDay ?? 'ALL');
  if (occupants?.has(id)) conflicts.push(CONFLICT.ALREADY_HERE);

  const shift = shiftOf(targetItem);
  if (WHITEBOARD_SHIFTS.includes(shift)) {
    // 同一時段當日已有別的點位
    if (index.onShift.get(`${shift}:${targetDay}`)?.has(id) && !occupants?.has(id)) {
      conflicts.push(CONFLICT.DUPLICATE_SHIFT);
    }
    // 當日已站過同名點位（跨時段也算）
    const mySpots = index.spots.get(targetDay)?.get(id);
    if (mySpots?.has(targetItem.item_name) && !occupants?.has(id)) {
      conflicts.push(CONFLICT.SAME_LOCATION);
    }
  } else if (shift === SHIFT.DAILY) {
    const mine = index.blackboardDaily.get(targetDay)?.get(id);
    if (mine && [...mine].some((itemId) => itemId !== targetItem.item_id)) conflicts.push(CONFLICT.BLACKBOARD_DOUBLE);
    if (index.allWeek.has(id)) conflicts.push(CONFLICT.ALL_WEEK_HELD);
  } else if (shift === SHIFT.ALL_WEEK) {
    const mine = index.allWeek.get(id);
    if (mine && [...mine].some((itemId) => itemId !== targetItem.item_id)) conflicts.push(CONFLICT.ALL_WEEK_HELD);
  }

  return [...new Set(conflicts)];
}

function dimensionOf(item) {
  switch (shiftOf(item)) {
    case SHIFT.MORNING: return DIMENSION.MORNING;
    case SHIFT.FLAG: return DIMENSION.FLAG;
    case SHIFT.NOON: return DIMENSION.NOON;
    default: return DIMENSION.BLACKBOARD;
  }
}

/**
 * Plan X 補位推薦。
 *
 * 排序：無衝突優先 → 該維度歷史次數少者優先
 *      → 本週指派次數少者優先 → staff_id。
 *
 * @returns {Array<{staff_id, name, conflicts, historyCount, weekAssigned}>}
 */
export function recommendReplacements({
  staff, targetItem, targetDay, rows, itemsById, stats = new Map(),
  absences = [], weekStartDate, excludeStaffId = null, limit = 8,
}) {
  const index = buildBoardIndex(rows, itemsById);
  const absentSet = absentDays(absences, weekStartDate);
  const dimension = dimensionOf(targetItem);
  const statKey = DIMENSION_COLUMN[dimension];

  const scored = staff
    .filter((s) => s.staff_id !== excludeStaffId)
    .map((s) => {
      const conflicts = checkConflicts({ candidate: s, targetItem, targetDay, index, absentSet });
      const stat = stats.get(s.staff_id) ?? {};
      return {
        staff_id: s.staff_id,
        name: s.name,
        staff_group: s.staff_group,
        role: s.role,
        conflicts,
        historyCount: stat[statKey] ?? 0,
        weekAssigned: index.weekAssigned.get(s.staff_id) ?? 0,
      };
    })
    // 徒弟不排班，直接不列入；已在同一點位者也不列入
    .filter((c) => !c.conflicts.includes(CONFLICT.ALREADY_HERE))
    .filter((c) => !c.conflicts.includes(CONFLICT.APPRENTICE));

  scored.sort((a, b) => {
    if ((a.conflicts.length === 0) !== (b.conflicts.length === 0)) return a.conflicts.length === 0 ? -1 : 1;
    if (a.conflicts.length !== b.conflicts.length) return a.conflicts.length - b.conflicts.length;
    if (a.historyCount !== b.historyCount) return a.historyCount - b.historyCount;
    if (a.weekAssigned !== b.weekAssigned) return a.weekAssigned - b.weekAssigned;
    return a.staff_id - b.staff_id;
  });

  return scored.slice(0, limit);
}
