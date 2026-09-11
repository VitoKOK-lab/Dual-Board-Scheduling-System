/**
 * 換人與補位。
 *
 * 主管點名牌換人時，依當前負擔由輕到重推薦可用的師傅。
 * 規格 §1 明訂主管具 100% 強制覆寫權，因此本模組只「回報衝突」，不阻擋指派。
 */

import { BOARD, ROLE, SHIFT, WEEK_DAYS, WEEKLY_SHIFTS } from './constants.js';
import { DIMENSION, DIMENSION_COLUMN } from './fairness.js';

export const CONFLICT = {
  INACTIVE: 'INACTIVE',                   // 人員已停用
  APPRENTICE: 'APPRENTICE',               // 徒弟尚未升級為師傅，不能排班
  DUPLICATE_SHIFT: 'DUPLICATE_SHIFT',     // 同時段已有其他點位
  SAME_LOCATION: 'SAME_LOCATION',         // 本週已站過同一個點位
  BLACKBOARD_DOUBLE: 'BLACKBOARD_DOUBLE', // 當日已有其他黑板任務
  ALL_WEEK_HELD: 'ALL_WEEK_HELD',         // 已擔任全週職務
  ALREADY_HERE: 'ALREADY_HERE',           // 已在同一點位
};

export const CONFLICT_LABEL = {
  [CONFLICT.INACTIVE]: '人員已停用',
  [CONFLICT.APPRENTICE]: '徒弟，尚未升級為師傅',
  [CONFLICT.DUPLICATE_SHIFT]: '同時段已有點位',
  [CONFLICT.SAME_LOCATION]: '本週已站過同一點位',
  [CONFLICT.BLACKBOARD_DOUBLE]: '當日已有其他黑板任務',
  [CONFLICT.ALL_WEEK_HELD]: '已擔任全週職務',
  [CONFLICT.ALREADY_HERE]: '已在同一點位',
};

function shiftOf(item) {
  if (!item) return null;
  if (item.board_type === BOARD.SPECIAL) return SHIFT.SPECIAL;
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
    weeklyShift: new Map(),     // shift -> Set<staffId>，依週指派的時段
    weeklySpots: new Map(),     // staffId -> Set<item_name>，本週站過的白板點位
    flagByDay: new Map(),       // day -> Set<staffId>
    blackboardDaily: new Map(), // day -> Map<staffId, Set<item_id>>
    allWeek: new Map(),         // staffId -> Set<item_id>
    occupancy: new Map(),       // item_id -> Map<day|'ALL', Set<staffId>>
    weekAssigned: new Map(),    // staffId -> 本週被指派次數
  };
  for (const shift of WEEKLY_SHIFTS) index.weeklyShift.set(shift, new Set());
  for (const d of WEEK_DAYS) {
    index.flagByDay.set(d, new Set());
    index.blackboardDaily.set(d, new Map());
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
    if (WEEKLY_SHIFTS.includes(shift)) {
      index.weeklyShift.get(shift).add(row.staff_id);
      push(index.weeklySpots, row.staff_id, item.item_name);
    } else if (shift === SHIFT.FLAG) {
      index.flagByDay.get(row.day_of_week)?.add(row.staff_id);
    } else if (shift === SHIFT.DAILY) {
      push(index.blackboardDaily.get(row.day_of_week), row.staff_id, item.item_id);
    } else if (shift === SHIFT.ALL_WEEK) {
      push(index.allWeek, row.staff_id, item.item_id);
    }
  }

  return index;
}

/**
 * 檢查把 candidate 放進 targetItem/targetDay 會踩到哪些限制。
 * @returns {string[]} 衝突代碼陣列（空陣列代表完全合規）
 */
export function checkConflicts({ candidate, targetItem, targetDay, index }) {
  const conflicts = [];
  const id = candidate.staff_id;

  if (!candidate.is_active) conflicts.push(CONFLICT.INACTIVE);
  if (candidate.role !== ROLE.MASTER) conflicts.push(CONFLICT.APPRENTICE);

  const occupants = index.occupancy.get(targetItem.item_id)?.get(targetDay ?? 'ALL');
  const alreadyHere = Boolean(occupants?.has(id));
  if (alreadyHere) conflicts.push(CONFLICT.ALREADY_HERE);

  const shift = shiftOf(targetItem);
  if (WEEKLY_SHIFTS.includes(shift)) {
    // 依週指派：同一時段本週只站一個點位，且不重複站同名地點
    if (!alreadyHere && index.weeklyShift.get(shift)?.has(id)) conflicts.push(CONFLICT.DUPLICATE_SHIFT);
    if (!alreadyHere && index.weeklySpots.get(id)?.has(targetItem.item_name)) {
      conflicts.push(CONFLICT.SAME_LOCATION);
    }
  } else if (shift === SHIFT.FLAG) {
    if (!alreadyHere && index.flagByDay.get(targetDay)?.has(id)) conflicts.push(CONFLICT.DUPLICATE_SHIFT);
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
    case SHIFT.SPECIAL: return DIMENSION.SPECIAL;
    default: return DIMENSION.BLACKBOARD;
  }
}

/**
 * 換人推薦。
 *
 * 排序：無衝突者優先 → 該維度歷史次數少者 → 本週已排次數少者 → staff_id。
 *
 * @returns {Array<{staff_id, name, conflicts, historyCount, weekAssigned}>}
 */
export function recommendReplacements({
  staff, targetItem, targetDay, rows, itemsById, stats = new Map(),
  excludeStaffId = null, limit = 8,
}) {
  const index = buildBoardIndex(rows, itemsById);
  const statKey = DIMENSION_COLUMN[dimensionOf(targetItem)];

  const scored = staff
    .filter((s) => s.staff_id !== excludeStaffId)
    .map((s) => {
      const stat = stats.get(s.staff_id) ?? {};
      return {
        staff_id: s.staff_id,
        name: s.name,
        staff_group: s.staff_group,
        role: s.role,
        conflicts: checkConflicts({ candidate: s, targetItem, targetDay, index }),
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
