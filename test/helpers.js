import { BOARD, ROLE, SHIFT, ZONE } from '../src/domain/constants.js';

let nextId = 1;

/**
 * 產生測試人員。預設全部是師傅（可排班）；
 * 傳入 `apprentices` 可讓最後 N 位變成徒弟（不排班）。
 */
export function makeStaff(count, { activeAll = true, apprentices = 0 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    staff_id: i + 1,
    name: `員工${i + 1}`,
    staff_group: i < count - apprentices ? '高二組' : '高一組',
    role: i < count - apprentices ? ROLE.MASTER : ROLE.APPRENTICE,
    is_active: activeAll,
  }));
}

export const mastersOf = (staff) => staff.filter((s) => s.role === ROLE.MASTER);
export const apprenticesOf = (staff) => staff.filter((s) => s.role === ROLE.APPRENTICE);

export function item(board, shift, name, capacity = 1, sortOrder = 0, zone = '') {
  return {
    item_id: nextId++,
    board_type: board,
    shift_type: shift,
    item_name: name,
    required_capacity: capacity,
    zone,
    sort_order: sortOrder,
  };
}

/**
 * 建立一組貼近實際校園配置的點位字典。
 * 白板的早修與午休是依週指派（一個點位整週同一人），
 * 升旗是事件，只在指定的升旗日才排；公差則由主管手動指派。
 */
export function makeItems({
  morningPoints = 4, flagPoints = 4, noonPoints = 4, specialTasks = 2, capacity = 2,
} = {}) {
  nextId = 1;
  const names = ['育英樓', '教大', '7-11', '正門', '後門', '活動中心', '圖書館', '體育館'];
  const tasks = ['辦公室', '地下室', '教務處'];
  return [
    item(BOARD.BLACKBOARD, SHIFT.ALL_WEEK, '交接', 1, 10),
    item(BOARD.BLACKBOARD, SHIFT.ALL_WEEK, '值日生', 1, 20),
    item(BOARD.BLACKBOARD, SHIFT.DAILY, '餐車', 1, 30),
    item(BOARD.BLACKBOARD, SHIFT.DAILY, '早修升旗', 1, 40),
    item(BOARD.BLACKBOARD, SHIFT.DAILY, '午休回來', 1, 50),
    ...names.slice(0, morningPoints).map((n, i) => item(BOARD.WHITEBOARD, SHIFT.MORNING, n, capacity, (i + 1) * 10)),
    // 升旗分定點與巡查兩區，屬同一時段
    ...names.slice(0, flagPoints).map((n, i) => item(
      BOARD.WHITEBOARD, SHIFT.FLAG, n, capacity, (i + 1) * 10,
      i < Math.ceil(flagPoints / 2) ? ZONE.FIXED : ZONE.PATROL,
    )),
    ...names.slice(0, noonPoints).map((n, i) => item(BOARD.WHITEBOARD, SHIFT.NOON, n, capacity, (i + 1) * 10)),
    ...tasks.slice(0, specialTasks).map((n, i) => item(BOARD.SPECIAL, SHIFT.SPECIAL, n, 1, (i + 1) * 10)),
  ];
}

/** 白板依週指派，同一個時段的名額總數就是這個時段一次要動用的人數。 */
export const slotsIn = (items, board, shift) => items
  .filter((i) => i.board_type === board && i.shift_type === shift)
  .reduce((sum, i) => sum + i.required_capacity, 0);

export function indexItems(items) {
  return new Map(items.map((i) => [i.item_id, i]));
}
