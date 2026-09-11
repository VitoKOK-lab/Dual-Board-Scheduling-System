/** 規格 §2.1：一週僅排週一至週五。 */
export const WEEK_DAYS = [1, 2, 3, 4, 5];

export const DAY_LABELS = {
  1: '週一',
  2: '週二',
  3: '週三',
  4: '週四',
  5: '週五',
};

export const BOARD = {
  WHITEBOARD: 'WHITEBOARD',
  BLACKBOARD: 'BLACKBOARD',
  SPECIAL: 'SPECIAL',     // 公差：隊裡的特殊任務
};

export const SHIFT = {
  MORNING: 'MORNING',     // 早修 —— 整週同一人
  FLAG: 'FLAG',           // 升旗 —— 只在指定的升旗日，平常整塊空著
  NOON: 'NOON',           // 午休 —— 整週同一人
  ALL_WEEK: 'ALL_WEEK',   // 黑板全週職務
  DAILY: 'DAILY',         // 黑板每日職務
  SPECIAL: 'SPECIAL',     // 公差 —— 主管手動指派
};

export const SHIFT_LABEL = {
  [SHIFT.MORNING]: '早修',
  [SHIFT.FLAG]: '升旗',
  [SHIFT.NOON]: '午休',
  [SHIFT.ALL_WEEK]: '全週職務',
  [SHIFT.DAILY]: '每日職務',
  [SHIFT.SPECIAL]: '公差',
};

/**
 * 白板依週指派的時段：一個點位整週同一人，一週洗牌一次。
 * 升旗不在其中——它是事件，只在升旗日才排。
 */
export const WEEKLY_SHIFTS = [SHIFT.MORNING, SHIFT.NOON];

/** 白板的三個時段，依實際作息先後排列。 */
export const WHITEBOARD_SHIFTS = [SHIFT.MORNING, SHIFT.FLAG, SHIFT.NOON];

/** 升旗時段內的任務分區，僅供看板分組顯示。 */
export const ZONE = {
  FIXED: '定點',
  PATROL: '巡查',
};

/**
 * 師徒制：只有「師傅」進入排班池。
 * 徒弟跟著自己的師傅學習，不排班、不計入點位人數，
 * 由主管手動升級為師傅後才會被排到班。
 */
export const ROLE = {
  MASTER: 'MASTER',
  APPRENTICE: 'APPRENTICE',
};

export const ROLE_LABEL = {
  [ROLE.MASTER]: '師傅',
  [ROLE.APPRENTICE]: '徒弟',
};

export const WARNING = {
  UNDERSTAFFED: 'UNDERSTAFFED',             // 點位人數不足，留下空缺
  CONSTRAINT_RELAXED: 'CONSTRAINT_RELAXED', // 為填滿點位而放寬軟性限制
  CAPACITY_EXCEEDED: 'CAPACITY_EXCEEDED',   // 名額總數超過可排班師傅數
  IDLE_STAFF: 'IDLE_STAFF',                 // 有師傅整週沒有任何任務
};
