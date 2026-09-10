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
  MORNING: 'MORNING',
  NOON: 'NOON',
  ALL_WEEK: 'ALL_WEEK',
  DAILY: 'DAILY',
};

/** 規格 §2.3：Plan Y 預備隊人數區間。 */
export const STANDBY_MIN = 2;
export const STANDBY_MAX = 3;

export const WARNING = {
  UNDERSTAFFED: 'UNDERSTAFFED',           // 點位人數不足
  CONSTRAINT_RELAXED: 'CONSTRAINT_RELAXED', // 為填滿點位而放寬軟性限制
  STANDBY_SHORT: 'STANDBY_SHORT',         // 預備隊人數不足 2 人
};
