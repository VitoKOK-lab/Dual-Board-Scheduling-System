import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFLICT, buildBoardIndex, checkConflicts, recommendReplacements } from '../src/domain/planX.js';
import { BOARD, ROLE, SHIFT } from '../src/domain/constants.js';
import { indexItems, makeItems, makeStaff } from './helpers.js';

function fixture() {
  const items = makeItems({ morningPoints: 3, noonPoints: 3, capacity: 2 });
  const byId = indexItems(items);
  const staff = makeStaff(10);
  const pick = (board, shift) => items.filter((i) => i.board_type === board && i.shift_type === shift);
  return {
    items,
    byId,
    staff,
    morning: pick(BOARD.WHITEBOARD, SHIFT.MORNING),
    noon: pick(BOARD.WHITEBOARD, SHIFT.NOON),
    flag: pick(BOARD.WHITEBOARD, SHIFT.FLAG),
    special: pick(BOARD.SPECIAL, SHIFT.SPECIAL),
  };
}

const row = (o) => ({
  detail_id: o.detail_id ?? 1,
  staff_id: o.staff_id ?? null,
  item_id: o.item_id ?? null,
  day_of_week: o.day_of_week ?? null,
  slot_index: 0,
});

const master = (id) => ({ staff_id: id, is_active: true, role: ROLE.MASTER });

test('偵測：本週同一時段已有其他點位（白板依週指派）', () => {
  const { byId, morning } = fixture();
  const rows = [row({ staff_id: 7, item_id: morning[0].item_id })];
  const conflicts = checkConflicts({
    candidate: master(7),
    targetItem: morning[1],
    targetDay: null,
    index: buildBoardIndex(rows, byId),
  });
  assert.ok(conflicts.includes(CONFLICT.DUPLICATE_SHIFT));
});

test('偵測：本週早修與午休排在同一個點位', () => {
  const { byId, morning, noon } = fixture();
  const rows = [row({ staff_id: 4, item_id: morning[0].item_id })];
  const target = noon.find((i) => i.item_name === morning[0].item_name);
  const conflicts = checkConflicts({
    candidate: master(4),
    targetItem: target,
    targetDay: null,
    index: buildBoardIndex(rows, byId),
  });
  assert.ok(conflicts.includes(CONFLICT.SAME_LOCATION));
});

test('不同點位的早修 / 午休組合不算衝突', () => {
  const { byId, morning, noon } = fixture();
  const rows = [row({ staff_id: 4, item_id: morning[0].item_id })];
  const target = noon.find((i) => i.item_name !== morning[0].item_name);
  const conflicts = checkConflicts({
    candidate: master(4),
    targetItem: target,
    targetDay: null,
    index: buildBoardIndex(rows, byId),
  });
  assert.deepEqual(conflicts, []);
});

test('偵測：同一個升旗日已經站了另一個升旗點位', () => {
  const { byId, flag } = fixture();
  const rows = [row({ staff_id: 6, item_id: flag[0].item_id, day_of_week: 3 })];
  const index = buildBoardIndex(rows, byId);

  assert.ok(checkConflicts({
    candidate: master(6), targetItem: flag[1], targetDay: 3, index,
  }).includes(CONFLICT.DUPLICATE_SHIFT));

  // 另一個升旗日就不衝突——升旗是事件，各天各排一輪
  assert.deepEqual(checkConflicts({
    candidate: master(6), targetItem: flag[1], targetDay: 5, index,
  }), []);
});

test('偵測：人員已停用', () => {
  const { byId, morning } = fixture();
  const conflicts = checkConflicts({
    candidate: { staff_id: 2, is_active: false, role: ROLE.MASTER },
    targetItem: morning[0],
    targetDay: null,
    index: buildBoardIndex([], byId),
  });
  assert.ok(conflicts.includes(CONFLICT.INACTIVE));
});

test('公差不受白板的依週限制影響，同一人可以再接公差', () => {
  const { byId, morning, special } = fixture();
  const rows = [row({ staff_id: 5, item_id: morning[0].item_id })];
  const conflicts = checkConflicts({
    candidate: master(5),
    targetItem: special[0],
    targetDay: null,
    index: buildBoardIndex(rows, byId),
  });
  assert.deepEqual(conflicts, []);
});

test('偵測：已擔任全週職務者不宜再接每日黑板任務', () => {
  const { byId, items } = fixture();
  const allWeek = items.find((i) => i.shift_type === SHIFT.ALL_WEEK);
  const daily = items.find((i) => i.shift_type === SHIFT.DAILY);
  const rows = [row({ staff_id: 5, item_id: allWeek.item_id })];
  const conflicts = checkConflicts({
    candidate: master(5),
    targetItem: daily,
    targetDay: 2,
    index: buildBoardIndex(rows, byId),
  });
  assert.ok(conflicts.includes(CONFLICT.ALL_WEEK_HELD));
});

test('有衝突者一律排在無衝突者之後', () => {
  const { byId, staff, morning } = fixture();
  // 9 號本週已經站了另一個早修點位 → 有衝突
  const rows = [row({ staff_id: 9, item_id: morning[1].item_id })];
  const result = recommendReplacements({
    staff,
    targetItem: morning[0],
    targetDay: null,
    rows,
    itemsById: byId,
    stats: new Map(),
    limit: 10,
  });
  assert.ok(result[0].conflicts.length === 0);
  const nine = result.find((c) => c.staff_id === 9);
  assert.ok(result.indexOf(nine) > 0);
  assert.ok(nine.conflicts.some((c) => c === CONFLICT.DUPLICATE_SHIFT));
});

test('無衝突者之間依該時段歷史次數由少到多排序', () => {
  const { byId, staff, morning } = fixture();
  const stats = new Map(staff.map((s) => [s.staff_id, {
    blackboard_count: 0,
    morning_whiteboard_count: s.staff_id === 6 ? 0 : 30,
    noon_whiteboard_count: 0,
  }]));
  const result = recommendReplacements({
    staff, targetItem: morning[0], targetDay: null, rows: [], itemsById: byId, stats,
  });
  assert.equal(result[0].staff_id, 6);
});

test('公差的推薦依公差累計次數排序，不看白板次數', () => {
  const { byId, staff, special } = fixture();
  const stats = new Map(staff.map((s) => [s.staff_id, {
    blackboard_count: 0,
    morning_whiteboard_count: s.staff_id === 8 ? 0 : 99,
    special_count: s.staff_id === 8 ? 40 : 0,
  }]));
  const result = recommendReplacements({
    staff, targetItem: special[0], targetDay: null, rows: [], itemsById: byId, stats, limit: 20,
  });
  assert.notEqual(result[0].staff_id, 8, '公差次數最多的人不該排在第一個');
  assert.equal(result.at(-1).staff_id, 8);
});

test('已在同一名額的人不會被列入候選', () => {
  const { byId, staff, morning } = fixture();
  const rows = [row({ staff_id: 3, item_id: morning[0].item_id })];
  const result = recommendReplacements({
    staff, targetItem: morning[0], targetDay: null, rows, itemsById: byId, stats: new Map(),
  });
  assert.ok(!result.some((c) => c.staff_id === 3));
});

test('limit 會先保留無衝突者，衝突者被截斷', () => {
  const { byId, staff, morning } = fixture();
  const rows = [row({ staff_id: 9, item_id: morning[1].item_id })];
  const result = recommendReplacements({
    staff, targetItem: morning[0], targetDay: null, rows, itemsById: byId,
    stats: new Map(), limit: 3,
  });
  assert.equal(result.length, 3);
  assert.ok(result.every((c) => c.conflicts.length === 0));
});

test('徒弟不會出現在補位推薦名單', () => {
  const { byId, morning } = fixture();
  const staff = makeStaff(12, { apprentices: 5 });
  const result = recommendReplacements({
    staff, targetItem: morning[0], targetDay: null, rows: [], itemsById: byId,
    stats: new Map(), limit: 20,
  });
  assert.equal(result.length, 7, '只有 7 位師傅可補位');
  for (const c of result) {
    assert.equal(c.role, ROLE.MASTER, `${c.name} 是徒弟卻出現在候選名單`);
  }
});

test('把徒弟放進名額會回報 APPRENTICE 衝突', () => {
  const { byId, morning } = fixture();
  const apprentice = makeStaff(12, { apprentices: 5 }).at(-1);
  const conflicts = checkConflicts({
    candidate: apprentice,
    targetItem: morning[0],
    targetDay: null,
    index: buildBoardIndex([], byId),
  });
  assert.ok(conflicts.includes(CONFLICT.APPRENTICE));
});

test('師傅放進名額不算角色衝突', () => {
  const { byId, morning } = fixture();
  const person = makeStaff(12, { apprentices: 5 })[0];
  const conflicts = checkConflicts({
    candidate: person,
    targetItem: morning[0],
    targetDay: null,
    index: buildBoardIndex([], byId),
  });
  assert.deepEqual(conflicts, []);
});
