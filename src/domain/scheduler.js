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
 * 帶班制（校內既有的高二帶高一）：
 *   白板每個點位的第 1 個名額是「帶班位」，只有帶班組（高二）能站，
 *   排不出來就留空缺，絕不由被帶組頂替——這是硬性規定。
 *   其餘名額為「一般位」，以被帶組（高一）為主，人力不足時才放寬。
 *
 * 因為兩種名額的候選池不重疊，公平性自然是分組各自累計。
 */

import {
  BOARD, LEADER_GROUP, MEMBER_GROUP, SHIFT, SLOT_ROLE,
  STANDBY_MAX, STANDBY_MIN, WARNING, WEEK_DAYS,
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
  // A. Plan Y — 靜態預備隊（最先選，被選中者整週完全不排班）
  //    依「擔任預備隊次數」輪替待命權：待命最少者優先，
  //    平手時讓累計負擔最重的人休息。只從被帶組挑選。
  // ---------------------------------------------------------------
  const wanted = Math.min(Math.max(standbyCount, STANDBY_MIN), STANDBY_MAX);
  const standbyPool = pool
    .filter((s) => s.staff_group === MEMBER_GROUP)
    .filter((s) => !WEEK_DAYS.some((d) => state.isAbsent(s.staff_id, d)))
    .sort(standbyComparator(tracker, tieRanks));
  const standby = standbyPool.slice(0, wanted).map((s) => s.staff_id);
  const standbySet = new Set(standby);

  if (standby.length < STANDBY_MIN) {
    warn(WARNING.STANDBY_SHORT, { available: standby.length, required: STANDBY_MIN });
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
  // D / E. 白板矩陣：每點先排帶班位，再排一般位
  // ---------------------------------------------------------------
  const leaderPool = pool.filter((s) => s.staff_group === LEADER_GROUP);
  const memberPool = pool.filter((s) => s.staff_group === MEMBER_GROUP && !standbySet.has(s.staff_id));

  const shifts = [
    { shift: SHIFT.MORNING, dimension: DIMENSION.MORNING, comparator: morningCmp, placedBy: state.morningByDay, otherBy: state.noonByDay },
    { shift: SHIFT.NOON, dimension: DIMENSION.NOON, comparator: noonCmp, placedBy: state.noonByDay, otherBy: state.morningByDay },
  ];

  for (const { shift, dimension, comparator, placedBy, otherBy } of shifts) {
    for (const item of selectItems(items, BOARD.WHITEBOARD, shift)) {
      const leaderSlots = Math.min(item.leader_count ?? 0, item.required_capacity);

      for (const day of WEEK_DAYS) {
        const placed = placedBy.get(day);
        const other = otherBy.get(day);

        // 同日不重複站點、同日早修點位 ≠ 午休點位
        const available = (s) => !state.isAbsent(s.staff_id, day)
          && !placed.has(s.staff_id)
          && other.get(s.staff_id) !== item.item_name;

        for (let slot = 0; slot < item.required_capacity; slot += 1) {
          const isLeaderSlot = slot < leaderSlots;
          const role = isLeaderSlot ? SLOT_ROLE.LEADER : SLOT_ROLE.MEMBER;

          // 帶班位：只從帶班組挑，永不放寬（排不出來就留空缺）
          // 一般位：被帶組優先，人力不足時才放寬到帶班組並標記
          let { staff: chosen } = pickCandidate(
            isLeaderSlot ? leaderPool : memberPool, [available], comparator,
          );
          let relaxed = false;
          if (!chosen && !isLeaderSlot) {
            ({ staff: chosen } = pickCandidate(leaderPool, [available], comparator));
            relaxed = Boolean(chosen);
          }

          if (!chosen) {
            warn(isLeaderSlot ? WARNING.NO_LEADER : WARNING.UNDERSTAFFED, {
              item_id: item.item_id, item_name: item.item_name, day_of_week: day, slot_role: role,
            });
            assignments.push({
              item_id: item.item_id, staff_id: null, day_of_week: day, slot_index: slot, slot_role: role,
            });
            continue;
          }
          if (relaxed) {
            warn(WARNING.CONSTRAINT_RELAXED, {
              item_id: item.item_id, item_name: item.item_name, day_of_week: day, staff_id: chosen.staff_id,
              slot_role: role, reason: '一般位由帶班組頂替',
            });
          }

          placed.set(chosen.staff_id, item.item_name);
          tracker.add(chosen.staff_id, dimension);
          assignments.push({
            item_id: item.item_id, staff_id: chosen.staff_id, day_of_week: day, slot_index: slot, slot_role: role,
          });
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
      slot_role: SLOT_ROLE.MEMBER,
      ...a,
    })),
    standby,
    warnings,
    load: tracker.snapshot(),
  };
}
