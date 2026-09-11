/**
 * 公平性權重模組 —— 規格 §4.1「排序權重」。
 *
 * 設計原則：
 * 1. 全部為 deterministic 計算，同樣輸入必得同樣班表，可回放、可測試。
 * 2. 排序不只看歷史累計，也即時累加「本次生成已指派的次數」，
 *    避免同一輪演算法把所有工作塞給同一位歷史次數最低的人。
 * 3. 同分時以「週別輪轉序」打破平手，讓低 staff_id 不會長期佔便宜。
 */

export const DIMENSION = {
  BLACKBOARD: 'blackboard',
  MORNING: 'morning',
  FLAG: 'flag',
  NOON: 'noon',
  SPECIAL: 'special',
};

/** 五個任務維度，各自獨立排序與累計。 */
export const WORK_DIMENSIONS = [
  DIMENSION.BLACKBOARD, DIMENSION.MORNING, DIMENSION.FLAG, DIMENSION.NOON, DIMENSION.SPECIAL,
];

/** fairness_stats 的欄位名對映。 */
export const DIMENSION_COLUMN = {
  [DIMENSION.BLACKBOARD]: 'blackboard_count',
  [DIMENSION.MORNING]: 'morning_whiteboard_count',
  [DIMENSION.FLAG]: 'flag_whiteboard_count',
  [DIMENSION.NOON]: 'noon_whiteboard_count',
  [DIMENSION.SPECIAL]: 'special_count',
};

/**
 * 以週起始日推導輪轉種子：距 1970-01-01 的天數。
 * 每週前進 7，配合 rotate 讓平手順序逐週位移。
 */
export function weekSeed(weekStartDate) {
  const ms = Date.parse(`${weekStartDate}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`無效的週起始日：${weekStartDate}`);
  return Math.floor(ms / 86_400_000);
}

/**
 * 平手序位：把人員依 staff_id 排好後，整體旋轉 seed % n 格。
 * @returns {Map<number, number>} staff_id -> 序位（越小越優先）
 */
export function buildTieRanks(staffList, weekStartDate) {
  const ids = staffList.map((s) => s.staff_id).sort((a, b) => a - b);
  const n = ids.length;
  const ranks = new Map();
  if (n === 0) return ranks;
  const offset = ((weekSeed(weekStartDate) % n) + n) % n;
  for (let i = 0; i < n; i += 1) {
    ranks.set(ids[(i + offset) % n], i);
  }
  return ranks;
}

/**
 * 負擔追蹤器：歷史統計 + 本週已指派量。
 */
export class LoadTracker {
  constructor(staffList, statsByStaffId = new Map()) {
    this.load = new Map();
    for (const s of staffList) {
      const base = statsByStaffId.get(s.staff_id) ?? {};
      this.load.set(s.staff_id, {
        blackboard: base.blackboard_count ?? 0,
        morning: base.morning_whiteboard_count ?? 0,
        flag: base.flag_whiteboard_count ?? 0,
        noon: base.noon_whiteboard_count ?? 0,
        special: base.special_count ?? 0,
        weekAssigned: 0,
      });
    }
  }

  #row(staffId) {
    let row = this.load.get(staffId);
    if (!row) {
      row = { blackboard: 0, morning: 0, flag: 0, noon: 0, special: 0, weekAssigned: 0 };
      this.load.set(staffId, row);
    }
    return row;
  }

  get(staffId, dimension) {
    return this.#row(staffId)[dimension];
  }

  /** 累計工作量（不含待命次數）。 */
  total(staffId) {
    const r = this.#row(staffId);
    return r.blackboard + r.morning + r.flag + r.noon + r.special;
  }

  weekAssigned(staffId) {
    return this.#row(staffId).weekAssigned;
  }

  /** 指派一次任務，同步累加該維度與本週指派量。 */
  add(staffId, dimension, amount = 1) {
    const r = this.#row(staffId);
    r[dimension] += amount;
    r.weekAssigned += amount;
    return r;
  }

  snapshot() {
    return new Map([...this.load].map(([k, v]) => [k, { ...v }]));
  }
}

/**
 * 建立指定維度的比較器：該維度次數 → 總負擔 → 平手輪轉序。
 */
export function comparatorFor(dimension, tracker, tieRanks) {
  return (a, b) => {
    const da = tracker.get(a.staff_id, dimension);
    const db = tracker.get(b.staff_id, dimension);
    if (da !== db) return da - db;

    const ta = tracker.total(a.staff_id);
    const tb = tracker.total(b.staff_id);
    if (ta !== tb) return ta - tb;

    const ra = tieRanks.get(a.staff_id) ?? a.staff_id;
    const rb = tieRanks.get(b.staff_id) ?? b.staff_id;
    if (ra !== rb) return ra - rb;

    return a.staff_id - b.staff_id;
  };
}
