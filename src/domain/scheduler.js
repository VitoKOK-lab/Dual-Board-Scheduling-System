/**
 * 一鍵自動排班引擎。
 *
 * 純函式：輸入人員 / 點位字典 / 公平性統計 / 升旗日，輸出整週指派結果。
 * 不碰資料庫、不依賴時間，因此可完整單元測試與回放。
 *
 * 執行順序：
 *   A. 黑板全週職務（交接、值日生）—— 1 人 1 週
 *   B. 黑板每日職務（餐車、早修、午休、校表）—— 每天各 1 人
 *   C. 白板依週指派（早修、午休）—— 一個點位整週同一人，一週洗牌一次
 *   D. 白板升旗 —— 只在指定的升旗日才排，平常整塊空著
 *
 * 公差（隊裡的特殊任務）不在這裡：它由主管手動指派，只是會計入公平性統計。
 *
 * 師徒制：只有「師傅」進入排班池。徒弟跟著自己的師傅學習，
 * 不排班、不計入點位人數，由主管手動升級為師傅後才會被排到班。
 *
 * 每個人都要有任務：所有可排班的師傅一律進入候選池，
 * 生成後若仍有人整週掛零會回報 IDLE_STAFF。
 */

import {
  BOARD, ROLE, SHIFT, SHIFT_LABEL, WARNING, WEEK_DAYS, WEEKLY_SHIFTS,
} from './constants.js';
import { DIMENSION, LoadTracker, buildTieRanks, comparatorFor } from './fairness.js';

/** 白板時段 → 公平性維度。 */
const SHIFT_DIMENSION = {
  [SHIFT.MORNING]: DIMENSION.MORNING,
  [SHIFT.FLAG]: DIMENSION.FLAG,
  [SHIFT.NOON]: DIMENSION.NOON,
};

function sortItems(items) {
  return [...items].sort((a, b) => (a.sort_order - b.sort_order) || (a.item_id - b.item_id));
}

function selectItems(items, boardType, shiftType) {
  return sortItems(items.filter((i) => i.board_type === boardType && i.shift_type === shiftType));
}

/** 本週狀態機：追蹤誰已經被排到哪裡。 */
class WeekState {
  constructor() {
    this.allWeekHolders = new Set();     // 已擔任全週職務者
    this.blackboardByDay = new Map();    // day -> Set<staffId>
    this.weeklySpots = new Map();        // staffId -> Set<item_name>，本週已站的白板點位
    this.flagByDay = new Map();          // day -> Set<staffId>
    for (const d of WEEK_DAYS) {
      this.blackboardByDay.set(d, new Set());
      this.flagByDay.set(d, new Set());
    }
  }

  /** 該員本週是否已站過同名的白板點位。 */
  hasWeeklySpot(staffId, itemName) {
    return this.weeklySpots.get(staffId)?.has(itemName) ?? false;
  }

  placeWeekly(staffId, itemName) {
    if (!this.weeklySpots.has(staffId)) this.weeklySpots.set(staffId, new Set());
    this.weeklySpots.get(staffId).add(itemName);
  }
}

/**
 * 依序套用多層候選條件，第一層為硬性 + 軟性限制，
 * 後續層逐步放寬軟性限制；硬性限制永不放寬。
 */
function pickCandidate(pool, filters, comparator) {
  for (let level = 0; level < filters.length; level += 1) {
    const candidates = pool.filter(filters[level]);
    if (candidates.length > 0) {
      candidates.sort(comparator);
      return { staff: candidates[0], relaxed: level > 0 };
    }
  }
  return { staff: null, relaxed: false };
}

export function generateWeeklyPlan({
  staff = [],
  items = [],
  stats = new Map(),
  weekStartDate,
  flagDays = [],
}) {
  if (!weekStartDate) throw new Error('generateWeeklyPlan 需要 weekStartDate');

  // 排班池只有師傅；徒弟不排班也不計入點位人數
  const pool = staff.filter((s) => s.is_active && s.role === ROLE.MASTER);
  const statsMap = stats instanceof Map
    ? stats
    : new Map(Object.entries(stats).map(([k, v]) => [Number(k), v]));

  const state = new WeekState();
  const tracker = new LoadTracker(pool, statsMap);
  const tieRanks = buildTieRanks(pool, weekStartDate);
  const blackboardCmp = comparatorFor(DIMENSION.BLACKBOARD, tracker, tieRanks);

  const assignments = [];
  const warnings = [];
  const warn = (code, detail) => warnings.push({ code, ...detail });

  const gap = (item, day, slotIndex = 0) => {
    warn(WARNING.UNDERSTAFFED, { item_id: item.item_id, item_name: item.item_name, day_of_week: day });
    assignments.push({ item_id: item.item_id, staff_id: null, day_of_week: day, slot_index: slotIndex });
  };

  /** 一個點位可能要站好幾個人；名額數就是 required_capacity。 */
  const slotsOf = (item) => Math.max(1, item.required_capacity ?? 1);
  const totalSlots = (list) => list.reduce((sum, i) => sum + slotsOf(i), 0);

  // ---------------------------------------------------------------
  // A. 黑板 — 全週固定職務（交接、值日生），各 1 人、1 週 1 次
  // ---------------------------------------------------------------
  for (const item of selectItems(items, BOARD.BLACKBOARD, SHIFT.ALL_WEEK)) {
    for (let slot = 0; slot < slotsOf(item); slot += 1) {
      const { staff: chosen } = pickCandidate(
        pool,
        [(s) => !state.allWeekHolders.has(s.staff_id)],
        blackboardCmp,
      );
      if (!chosen) { gap(item, null, slot); continue; }

      state.allWeekHolders.add(chosen.staff_id);
      tracker.add(chosen.staff_id, DIMENSION.BLACKBOARD);
      assignments.push({ item_id: item.item_id, staff_id: chosen.staff_id, day_of_week: null, slot_index: slot });
    }
  }

  // ---------------------------------------------------------------
  // B. 黑板 — 每日輪替職務（餐車、早修、午休、校表）
  // ---------------------------------------------------------------
  const dailyItems = selectItems(items, BOARD.BLACKBOARD, SHIFT.DAILY);
  for (const day of WEEK_DAYS) {
    const taken = state.blackboardByDay.get(day);
    for (const item of dailyItems) {
      for (let slot = 0; slot < slotsOf(item); slot += 1) {
        const { staff: chosen, relaxed } = pickCandidate(
          pool,
          [
            // 硬性：當日尚未有黑板任務；軟性：非全週職務持有者
            (s) => !taken.has(s.staff_id) && !state.allWeekHolders.has(s.staff_id),
            (s) => !taken.has(s.staff_id),
          ],
          blackboardCmp,
        );
        if (!chosen) { gap(item, day, slot); continue; }
        if (relaxed) {
          warn(WARNING.CONSTRAINT_RELAXED, {
            item_id: item.item_id, item_name: item.item_name, day_of_week: day,
            staff_id: chosen.staff_id, reason: '全週職務者兼任當日黑板任務',
          });
        }

        taken.add(chosen.staff_id);
        tracker.add(chosen.staff_id, DIMENSION.BLACKBOARD);
        assignments.push({ item_id: item.item_id, staff_id: chosen.staff_id, day_of_week: day, slot_index: slot });
      }
    }
  }

  // ---------------------------------------------------------------
  // C. 白板依週指派 —— 早修、午休。一個點位整週同一人。
  // ---------------------------------------------------------------
  for (const shift of WEEKLY_SHIFTS) {
    const shiftItems = selectItems(items, BOARD.WHITEBOARD, shift);
    if (shiftItems.length === 0) continue;

    const required = totalSlots(shiftItems);
    if (required > pool.length) {
      warn(WARNING.CAPACITY_EXCEEDED, {
        shift_type: shift,
        shift_label: SHIFT_LABEL[shift] ?? shift,
        required,
        available: pool.length,
        shortfall: required - pool.length,
      });
    }

    const comparator = comparatorFor(SHIFT_DIMENSION[shift], tracker, tieRanks);
    const placed = new Set();

    for (const item of shiftItems) {
      for (let slot = 0; slot < slotsOf(item); slot += 1) {
        const { staff: chosen } = pickCandidate(
          pool,
          [
            // 硬性：本週該時段尚未有點位、且本週沒站過同名點位（早修午休不重複同一地點）
            (s) => !placed.has(s.staff_id) && !state.hasWeeklySpot(s.staff_id, item.item_name),
          ],
          comparator,
        );
        if (!chosen) { gap(item, null, slot); continue; }

        placed.add(chosen.staff_id);
        state.placeWeekly(chosen.staff_id, item.item_name);
        tracker.add(chosen.staff_id, SHIFT_DIMENSION[shift]);
        assignments.push({ item_id: item.item_id, staff_id: chosen.staff_id, day_of_week: null, slot_index: slot });
      }
    }
  }

  // ---------------------------------------------------------------
  // D. 白板升旗 —— 只在指定的升旗日排，其餘時候整塊空著
  // ---------------------------------------------------------------
  const flagItems = selectItems(items, BOARD.WHITEBOARD, SHIFT.FLAG);
  const days = [...new Set(flagDays)].filter((d) => WEEK_DAYS.includes(d)).sort();

  const flagRequired = totalSlots(flagItems);
  if (flagItems.length > 0 && days.length > 0 && flagRequired > pool.length) {
    warn(WARNING.CAPACITY_EXCEEDED, {
      shift_type: SHIFT.FLAG,
      shift_label: SHIFT_LABEL[SHIFT.FLAG],
      required: flagRequired,
      available: pool.length,
      shortfall: flagRequired - pool.length,
    });
  }

  const flagCmp = comparatorFor(DIMENSION.FLAG, tracker, tieRanks);
  for (const day of days) {
    const taken = state.flagByDay.get(day);
    for (const item of flagItems) {
      for (let slot = 0; slot < slotsOf(item); slot += 1) {
        const { staff: chosen } = pickCandidate(
          pool,
          [(s) => !taken.has(s.staff_id)],
          flagCmp,
        );
        if (!chosen) { gap(item, day, slot); continue; }

        taken.add(chosen.staff_id);
        tracker.add(chosen.staff_id, DIMENSION.FLAG);
        assignments.push({ item_id: item.item_id, staff_id: chosen.staff_id, day_of_week: day, slot_index: slot });
      }
    }
  }

  // 每個人都要有任務：整週掛零的人要讓主管看見
  const idle = pool.filter((s) => tracker.weekAssigned(s.staff_id) === 0);
  if (idle.length > 0) {
    warn(WARNING.IDLE_STAFF, {
      staff_ids: idle.map((s) => s.staff_id),
      names: idle.map((s) => s.name),
    });
  }

  return {
    weekStartDate,
    flagDays: days,
    assignments: assignments.map((a) => ({ is_override: 0, ...a })),
    warnings,
    load: tracker.snapshot(),
  };
}
