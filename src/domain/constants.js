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
};

export const SHIFT = {
  MORNING: 'MORNING',   // 早修
  FLAG: 'FLAG',         // 升旗（含定點與巡查兩種任務，同一時段）
  NOON: 'NOON',         // 午休
  ALL_WEEK: 'ALL_WEEK', // 黑板全週職務
  DAILY: 'DAILY',       // 黑板每日職務
};

export const SHIFT_LABEL = {
  [SHIFT.MORNING]: '早修',
  [SHIFT.FLAG]: '升旗',
  [SHIFT.NOON]: '午休',
};

/**
 * 白板的三個時段，依實際作息先後排列。
 * 升旗的「定點」與「巡查」是同一時段的兩種任務，
 * 因此共用一個名額上限——一個人在升旗時段只會站一個位置。
 */
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
  MASTER: 'MASTER',       // 師傅：可排班
  APPRENTICE: 'APPRENTICE', // 徒弟：不排班
};

export const ROLE_LABEL = {
  [ROLE.MASTER]: '師傅',
  [ROLE.APPRENTICE]: '徒弟',
};

/** 規格 §2.3：Plan Y 預備隊人數區間。 */
export const STANDBY_MIN = 2;
export const STANDBY_MAX = 3;

export const WARNING = {
  UNDERSTAFFED: 'UNDERSTAFFED',             // 點位人數不足，留下空缺
  CONSTRAINT_RELAXED: 'CONSTRAINT_RELAXED', // 為填滿點位而放寬軟性限制
  STANDBY_SHORT: 'STANDBY_SHORT',           // 預備隊人數不足 2 人
  CAPACITY_EXCEEDED: 'CAPACITY_EXCEEDED',   // 單一時段名額總數超過可排班師傅數
};
