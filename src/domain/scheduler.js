/**
 * 一鍵自動排班引擎 —— 規格 §4。
 *
 * 純函式：輸入人員 / 點位字典 / 公平性統計 / 公差事件，輸出整週指派結果。
 * 不碰資料庫、不依賴時間，因此可完整單元測試與回放。
 *
 * 執行順序：
 *   A. Plan Y 預備隊 —— 最先選，被選中者整週完全不排班，真正待命
 *   B. 黑板全週職務（交接、值日生）
 *   C. 黑板每日職務（餐車、早修升旗、午休回來）
 *   D. 白板早修矩陣
 *   E. 白板午休矩陣（硬性限制：同人當日早修點位 ≠ 午休點位）
 *
 * 師徒制：只有「師傅」進入排班池。徒弟跟著自己的師傅學習，
 * 不排班、不計入點位人數，由主管手動升級為師傅後才會被排到班。
 *
 * 容量上限：每人每個時段只能站一個點位，因此單一時段的名額總數
 * 不能超過可排班的師傅數，超過的部分必然留空並回報 CAPACITY_EXCEEDED。
 */

import {
  BOARD, ROLE, SHIFT, STANDBY_MAX, STANDBY_MIN, WARNING, WEEK_DAYS,
} from './constants.js';
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

  // 排班池只有師傅；徒弟不排班也不計入點位人數
  const pool = staff.filter((s) => s.is_active && s.role === ROLE.MASTER);
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
  // A. Plan Y — 靜態預備隊（最先選，被選中者整週完全不排班）
  //    依「擔任預備隊次數」輪替待命權：待命最少者優先，
  //    平手時讓累計負擔最重的人休息。
  // ---------------------------------------------------------------
  // 預備隊不能挖走排班需要的人：先算出單一時段的尖峰名額數，
  // 剩下的餘裕才是可以留作待命的人數。班表填不滿比沒有預備隊嚴重。
  const peakDemand = Math.max(
    ...[SHIFT.MORNING, SHIFT.NOON].map((shift) => selectItems(items, BOARD.WHITEBOARD, shift)
      .reduce((sum, i) => sum + i.required_capacity, 0)),
    0,
  );
  const headroom = Math.max(0, pool.length - peakDemand);
  const wanted = Math.min(Math.max(standbyCount, STANDBY_MIN), STANDBY_MAX, headroom);

  const standbyPool = pool
    .filter((s) => !WEEK_DAYS.some((d) => state.isAbsent(s.staff_id, d)))
    .sort(standbyComparator(tracker, tieRanks));
  const standby = standbyPool.slice(0, wanted).map((s) => s.staff_id);
  const standbySet = new Set(standby);

  if (standby.length < STANDBY_MIN) {
    warn(WARNING.STANDBY_SHORT, {
      available: standby.length,
      required: STANDBY_MIN,
      masters: pool.length,
      peak_slots: peakDemand,
      reason: headroom < STANDBY_MIN ? '可排班師傅數扣掉尖峰名額後不足' : '可出勤人數不足',
    });
  }

  // ---------------------------------------------------------------
  // B. 黑板 — 全週固定職務（交接、值日生），各 1 人、1 週 1 次
  // ---------------------------------------------------------------
  // 預備隊整週待命，黑板任務也不排
  const dutyPool = pool.filter((s) => !standbySet.has(s.staff_id));

  for (const item of selectItems(items, BOARD.BLACKBOARD, SHIFT.ALL_WEEK)) {
    for (let slot = 0; slot < item.required_capacity; slot += 1) {
      const { staff: chosen, relaxed } = pickCandidate(
        dutyPool,
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
  // C. 黑板 — 每日輪替職務（餐車、早修升旗、午休回來）
  // ---------------------------------------------------------------
  const dailyItems = selectItems(items, BOARD.BLACKBOARD, SHIFT.DAILY);
  for (const day of WEEK_DAYS) {
    const taken = state.blackboardByDay.get(day);
    for (const item of dailyItems) {
      for (let slot = 0; slot < item.required_capacity; slot += 1) {
        const { staff: chosen, relaxed } = pickCandidate(
          dutyPool,
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
  // D / E. 白板矩陣 —— 早修、午休
  // ---------------------------------------------------------------
  const dutyPoolWhiteboard = pool.filter((s) => !standbySet.has(s.staff_id));

  const shifts = [
    { shift: SHIFT.MORNING, dimension: DIMENSION.MORNING, comparator: morningCmp, placedBy: state.morningByDay, otherBy: state.noonByDay },
    { shift: SHIFT.NOON, dimension: DIMENSION.NOON, comparator: noonCmp, placedBy: state.noonByDay, otherBy: state.morningByDay },
  ];

  for (const { shift, dimension, comparator, placedBy, otherBy } of shifts) {
    const shiftItems = selectItems(items, BOARD.WHITEBOARD, shift);
    const demand = shiftItems.reduce((sum, i) => sum + i.required_capacity, 0);

    // 每人每個時段只能站一個點位，供給上限就是可排班師傅數
    if (demand > dutyPoolWhiteboard.length) {
      warn(WARNING.CAPACITY_EXCEEDED, {
        shift_type: shift,
        required: demand,
        available: dutyPoolWhiteboard.length,
        shortfall: demand - dutyPoolWhiteboard.length,
      });
    }

    for (const item of shiftItems) {
      for (const day of WEEK_DAYS) {
        const placed = placedBy.get(day);
        const other = otherBy.get(day);

        for (let slot = 0; slot < item.required_capacity; slot += 1) {
          const { staff: chosen } = pickCandidate(
            dutyPoolWhiteboard,
            [
              // 硬性：當日可出勤、當日尚未站同時段的點位、
              //       且當日的早修點位 ≠ 午休點位
              (s) => !state.isAbsent(s.staff_id, day)
                && !placed.has(s.staff_id)
                && other.get(s.staff_id) !== item.item_name,
            ],
            comparator,
          );

          if (!chosen) {
            warn(WARNING.UNDERSTAFFED, {
              item_id: item.item_id, item_name: item.item_name, day_of_week: day,
            });
            assignments.push({ item_id: item.item_id, staff_id: null, day_of_week: day, slot_index: slot });
            continue;
          }

          placed.set(chosen.staff_id, item.item_name);
          tracker.add(chosen.staff_id, dimension);
          assignments.push({ item_id: item.item_id, staff_id: chosen.staff_id, day_of_week: day, slot_index: slot });
        }
      }
    }
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
