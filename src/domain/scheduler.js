/**
 * 一鍵自動排班引擎 —— 規格 §4。
 *
 * 純函式：輸入人員 / 點位字典 / 公平性統計 / 公差事件，輸出整週指派結果。
 * 不碰資料庫、不依賴時間，因此可完整單元測試與回放。
 *
 * 執行順序（規格 §4.1 ~ §4.4）：
 *   A. 黑板全週職務（交接、值日生）
 *   B. 黑板每日職務（餐車、早修升旗、午休回來）
 *   C. 白板早修矩陣
 *   D. 白板午休矩陣（硬性限制：同人當日早修點位 ≠ 午休點位）
 *   E. Plan Y 預備隊
 */

import { BOARD, SHIFT, STANDBY_MAX, STANDBY_MIN, WARNING, WEEK_DAYS } from './constants.js';
import { DIMENSION, LoadTracker, buildTieRanks, comparatorFor, standbyComparator } from './fairness.js';
import { dayOfWeekFor } from './week.js';

function sortItems(items) {
  return [...items].sort((a, b) => (a.sort_order - b.sort_order) || (a.item_id - b.item_id));
}

function selectItems(items, boardType, shiftType) {
  return sortItems(items.filter((i) => i.board_type === boardType && i.shift_type === shiftType));
}

/**
 * 本週狀態機：追蹤誰在哪一天、哪一個時段、哪一個點位已被佔用。
 */
class WeekState {
  constructor() {
    this.absent = new Set();             // `${staffId}:${day}`
    this.allWeekHolders = new Set();     // 已擔任全週職務者
    this.blackboardByDay = new Map();    // day -> Set<staffId>
    this.morningByDay = new Map();       // day -> Map<staffId, item_name>
    this.noonByDay = new Map();          // day -> Map<staffId, item_name>
    for (const d of WEEK_DAYS) {
      this.blackboardByDay.set(d, new Set());
      this.morningByDay.set(d, new Map());
      this.noonByDay.set(d, new Map());
    }
  }

  markAbsent(staffId, day) {
    this.absent.add(`${staffId}:${day}`);
  }

  isAbsent(staffId, day) {
    return this.absent.has(`${staffId}:${day}`);
  }

  isAbsentAnyDay(staffId) {
    return WEEK_DAYS.some((d) => this.isAbsent(staffId, d));
  }
}

/** 把公差事件轉成「人員 x 星期」的缺席標記。 */
function applyAbsences(state, absences, weekStartDate) {
  for (const a of absences ?? []) {
    const day = a.day_of_week ?? dayOfWeekFor(weekStartDate, a.absence_date);
    if (day) state.markAbsent(a.staff_id, day);
  }
}

/**
 * 依序套用多層候選條件，第一層為硬性 + 軟性限制，
 * 後續層逐步放寬軟性限制；硬性限制永不放寬。
 * @returns {{ staff: object|null, relaxed: boolean }}
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
  absences = [],
  weekStartDate,
  standbyCount = STANDBY_MAX,
}) {
  if (!weekStartDate) throw new Error('generateWeeklyPlan 需要 weekStartDate');

  const pool = staff.filter((s) => s.is_active);
  const statsMap = stats instanceof Map ? stats : new Map(Object.entries(stats).map(([k, v]) => [Number(k), v]));

  const state = new WeekState();
  applyAbsences(state, absences, weekStartDate);

  const tracker = new LoadTracker(pool, statsMap);
  const tieRanks = buildTieRanks(pool, weekStartDate);
  const blackboardCmp = comparatorFor(DIMENSION.BLACKBOARD, tracker, tieRanks);
  const morningCmp = comparatorFor(DIMENSION.MORNING, tracker, tieRanks);
  const noonCmp = comparatorFor(DIMENSION.NOON, tracker, tieRanks);

  const assignments = [];
  const warnings = [];

  const warn = (code, detail) => warnings.push({ code, ...detail });

  // ---------------------------------------------------------------
  // A. 黑板 — 全週固定職務（交接、值日生），各 1 人、1 週 1 次
  // ---------------------------------------------------------------
  for (const item of selectItems(items, BOARD.BLACKBOARD, SHIFT.ALL_WEEK)) {
    for (let slot = 0; slot < item.required_capacity; slot += 1) {
      const { staff: chosen, relaxed } = pickCandidate(
        pool,
        [
          // 硬性：未擔任其他全週職務；軟性：整週皆可出勤
          (s) => !state.allWeekHolders.has(s.staff_id) && !state.isAbsentAnyDay(s.staff_id),
          (s) => !state.allWeekHolders.has(s.staff_id),
        ],
        blackboardCmp,
      );

      if (!chosen) {
        warn(WARNING.UNDERSTAFFED, { item_id: item.item_id, item_name: item.item_name, day_of_week: null });
        assignments.push({ item_id: item.item_id, staff_id: null, day_of_week: null, slot_index: slot });
        continue;
      }
      if (relaxed) {
        warn(WARNING.CONSTRAINT_RELAXED, {
          item_id: item.item_id, item_name: item.item_name, day_of_week: null, staff_id: chosen.staff_id,
          reason: '本週有公差紀錄仍指派全週職務',
        });
      }

      state.allWeekHolders.add(chosen.staff_id);
      tracker.add(chosen.staff_id, DIMENSION.BLACKBOARD);
      assignments.push({ item_id: item.item_id, staff_id: chosen.staff_id, day_of_week: null, slot_index: slot });
    }
  }

  // ---------------------------------------------------------------
  // B. 黑板 — 每日輪替職務（餐車、早修升旗、午休回來）
  // ---------------------------------------------------------------
  const dailyItems = selectItems(items, BOARD.BLACKBOARD, SHIFT.DAILY);
  for (const day of WEEK_DAYS) {
    const taken = state.blackboardByDay.get(day);
    for (const item of dailyItems) {
      for (let slot = 0; slot < item.required_capacity; slot += 1) {
        const { staff: chosen, relaxed } = pickCandidate(
          pool,
          [
            // 硬性：當日可出勤、當日尚未有黑板任務；軟性：非全週職務持有者
            (s) => !state.isAbsent(s.staff_id, day) && !taken.has(s.staff_id) && !state.allWeekHolders.has(s.staff_id),
            (s) => !state.isAbsent(s.staff_id, day) && !taken.has(s.staff_id),
          ],
          blackboardCmp,
        );

        if (!chosen) {
          warn(WARNING.UNDERSTAFFED, { item_id: item.item_id, item_name: item.item_name, day_of_week: day });
          assignments.push({ item_id: item.item_id, staff_id: null, day_of_week: day, slot_index: slot });
          continue;
        }
        if (relaxed) {
          warn(WARNING.CONSTRAINT_RELAXED, {
            item_id: item.item_id, item_name: item.item_name, day_of_week: day, staff_id: chosen.staff_id,
            reason: '全週職務者兼任當日黑板任務',
          });
        }

        taken.add(chosen.staff_id);
        tracker.add(chosen.staff_id, DIMENSION.BLACKBOARD);
        assignments.push({ item_id: item.item_id, staff_id: chosen.staff_id, day_of_week: day, slot_index: slot });
      }
    }
  }

  // ---------------------------------------------------------------
  // C. 白板 — 早修矩陣
  // ---------------------------------------------------------------
  const morningItems = selectItems(items, BOARD.WHITEBOARD, SHIFT.MORNING);
  for (const day of WEEK_DAYS) {
    const placed = state.morningByDay.get(day);
    for (const item of morningItems) {
      for (let slot = 0; slot < item.required_capacity; slot += 1) {
        const { staff: chosen } = pickCandidate(
          pool,
          [
            // 硬性：當日可出勤、當日尚未站早修點位（一人一天一點）
            (s) => !state.isAbsent(s.staff_id, day) && !placed.has(s.staff_id),
          ],
          morningCmp,
        );

        if (!chosen) {
          warn(WARNING.UNDERSTAFFED, { item_id: item.item_id, item_name: item.item_name, day_of_week: day });
          assignments.push({ item_id: item.item_id, staff_id: null, day_of_week: day, slot_index: slot });
          continue;
        }

        placed.set(chosen.staff_id, item.item_name);
        tracker.add(chosen.staff_id, DIMENSION.MORNING);
        assignments.push({ item_id: item.item_id, staff_id: chosen.staff_id, day_of_week: day, slot_index: slot });
      }
    }
  }

  // ---------------------------------------------------------------
  // D. 白板 — 午休矩陣（硬性限制：同人當日早修點位 ≠ 午休點位）
  // ---------------------------------------------------------------
  const noonItems = selectItems(items, BOARD.WHITEBOARD, SHIFT.NOON);
  for (const day of WEEK_DAYS) {
    const morningPlaced = state.morningByDay.get(day);
    const placed = state.noonByDay.get(day);
    for (const item of noonItems) {
      for (let slot = 0; slot < item.required_capacity; slot += 1) {
        const { staff: chosen } = pickCandidate(
          pool,
          [
            (s) => !state.isAbsent(s.staff_id, day)
              && !placed.has(s.staff_id)
              && morningPlaced.get(s.staff_id) !== item.item_name,
          ],
          noonCmp,
        );

        if (!chosen) {
          warn(WARNING.UNDERSTAFFED, { item_id: item.item_id, item_name: item.item_name, day_of_week: day });
          assignments.push({ item_id: item.item_id, staff_id: null, day_of_week: day, slot_index: slot });
          continue;
        }

        placed.set(chosen.staff_id, item.item_name);
        tracker.add(chosen.staff_id, DIMENSION.NOON);
        assignments.push({ item_id: item.item_id, staff_id: chosen.staff_id, day_of_week: day, slot_index: slot });
      }
    }
  }

  // ---------------------------------------------------------------
  // E. Plan Y — 靜態預備隊（本週最空閒的 2~3 人）
  // ---------------------------------------------------------------
  const wanted = Math.min(Math.max(standbyCount, STANDBY_MIN), STANDBY_MAX);
  const standbyPool = pool
    .filter((s) => !WEEK_DAYS.every((d) => state.isAbsent(s.staff_id, d)))
    .sort(standbyComparator(tracker, tieRanks));
  const standby = standbyPool.slice(0, wanted).map((s) => s.staff_id);

  if (standby.length < STANDBY_MIN) {
    warn(WARNING.STANDBY_SHORT, { available: standby.length, required: STANDBY_MIN });
  }

  for (const [index, staffId] of standby.entries()) {
    assignments.push({
      item_id: null, staff_id: staffId, day_of_week: null, slot_index: index, is_plan_b_standby: 1,
    });
  }

  return {
    weekStartDate,
    assignments: assignments.map((a) => ({
      is_plan_b_standby: 0,
      is_override: 0,
      ...a,
    })),
    standby,
    warnings,
    load: tracker.snapshot(),
  };
}
