import { BOARD, SHIFT } from '../src/domain/constants.js';

let nextId = 1;

export function makeStaff(count, { activeAll = true } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    staff_id: i + 1,
    name: `員工${i + 1}`,
    is_active: activeAll,
  }));
}

export function item(board, shift, name, capacity = 1, sortOrder = 0) {
  return {
    item_id: nextId++,
    board_type: board,
    shift_type: shift,
    item_name: name,
    required_capacity: capacity,
    sort_order: sortOrder,
  };
}

/** 建立一組貼近實際校園配置的點位字典。 */
export function makeItems({ morningPoints = 4, noonPoints = 4, capacity = 2 } = {}) {
  nextId = 1;
  const names = ['育英樓', '教大', '7-11', '正門', '後門', '活動中心', '圖書館', '體育館'];
  return [
    item(BOARD.BLACKBOARD, SHIFT.ALL_WEEK, '交接', 1, 10),
    item(BOARD.BLACKBOARD, SHIFT.ALL_WEEK, '值日生', 1, 20),
    item(BOARD.BLACKBOARD, SHIFT.DAILY, '餐車', 1, 30),
    item(BOARD.BLACKBOARD, SHIFT.DAILY, '早修升旗', 1, 40),
    item(BOARD.BLACKBOARD, SHIFT.DAILY, '午休回來', 1, 50),
    ...names.slice(0, morningPoints).map((n, i) => item(BOARD.WHITEBOARD, SHIFT.MORNING, n, capacity, (i + 1) * 10)),
    ...names.slice(0, noonPoints).map((n, i) => item(BOARD.WHITEBOARD, SHIFT.NOON, n, capacity, (i + 1) * 10)),
  ];
}

export function indexItems(items) {
  return new Map(items.map((i) => [i.item_id, i]));
}
