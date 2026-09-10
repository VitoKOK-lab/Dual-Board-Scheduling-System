import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFLICT, buildBoardIndex, checkConflicts, recommendReplacements } from '../src/domain/planX.js';
import { BOARD, ROLE, SHIFT } from '../src/domain/constants.js';
import { indexItems, makeItems, makeStaff } from './helpers.js';

const WEEK = '2026-09-07';

function fixture() {
  const items = makeItems({ morningPoints: 3, noonPoints: 3, capacity: 2 });
  const byId = indexItems(items);
  const staff = makeStaff(10);
  const morning = items.filter((i) => i.board_type === BOARD.WHITEBOARD && i.shift_type === SHIFT.MORNING);
  const noon = items.filter((i) => i.board_type === BOARD.WHITEBOARD && i.shift_type === SHIFT.NOON);
  return { items, byId, staff, morning, noon };
}

const row = (o) => ({
  detail_id: o.detail_id ?? 1,
  staff_id: o.staff_id ?? null,
  item_id: o.item_id ?? null,
  day_of_week: o.day_of_week ?? null,
  is_plan_b_standby: o.is_plan_b_standby ?? false,
  slot_index: 0,
});

test('偵測：同一天同一時段已有其他點位', () => {
  const { byId, morning } = fixture();
  const rows = [row({ detail_id: 1, staff_id: 7, item_id: morning[0].item_id, day_of_week: 2 })];
  const conflicts = checkConflicts({
    candidate: { staff_id: 7, is_active: true, role: ROLE.MASTER },
    targetItem: morning[1],
    targetDay: 2,
    index: buildBoardIndex(rows, byId),
    absentSet: new Set(),
  });
  assert.ok(conflicts.includes(CONFLICT.DUPLICATE_SHIFT));
});

test('偵測：當日早修與午休點位重複', () => {
  const { byId, morning, noon } = fixture();
  const rows = [row({ detail_id: 1, staff_id: 4, item_id: morning[0].item_id, day_of_week: 3 })];
  const target = noon.find((i) => i.item_name === morning[0].item_name);
  const conflicts = checkConflicts({
    candidate: { staff_id: 4, is_active: true, role: ROLE.MASTER },
    targetItem: target,
    targetDay: 3,
    index: buildBoardIndex(rows, byId),
    absentSet: new Set(),
  });
  assert.ok(conflicts.includes(CONFLICT.SAME_LOCATION));
});

test('不同點位的早修 / 午休組合不算衝突', () => {
  const { byId, morning, noon } = fixture();
  const rows = [row({ detail_id: 1, staff_id: 4, item_id: morning[0].item_id, day_of_week: 3 })];
  const target = noon.find((i) => i.item_name !== morning[0].item_name);
  const conflicts = checkConflicts({
    candidate: { staff_id: 4, is_active: true, role: ROLE.MASTER },
    targetItem: target,
    targetDay: 3,
    index: buildBoardIndex(rows, byId),
    absentSet: new Set(),
  });
  assert.deepEqual(conflicts, []);
});

test('偵測：當日有公差、以及人員已停用', () => {
  const { byId, morning } = fixture();
  const index = buildBoardIndex([], byId);
  assert.ok(checkConflicts({
    candidate: { staff_id: 2, is_active: true, role: ROLE.MASTER },
    targetItem: morning[0],
    targetDay: 1,
    index,
    absentSet: new Set(['2:1']),
  }).includes(CONFLICT.ABSENT));

  assert.ok(checkConflicts({
    candidate: { staff_id: 2, is_active: false, role: ROLE.MASTER },
    targetItem: morning[0],
    targetDay: 1,
    index,
    absentSet: new Set(),
  }).includes(CONFLICT.INACTIVE));
});

test('偵測：已擔任全週職務者不宜再接每日黑板任務', () => {
  const { byId, items } = fixture();
  const allWeek = items.find((i) => i.shift_type === SHIFT.ALL_WEEK);
  const daily = items.find((i) => i.shift_type === SHIFT.DAILY);
  const rows = [row({ detail_id: 1, staff_id: 5, item_id: allWeek.item_id, day_of_week: null })];
  const conflicts = checkConflicts({
    candidate: { staff_id: 5, is_active: true, role: ROLE.MASTER },
    targetItem: daily,
    targetDay: 2,
    index: buildBoardIndex(rows, byId),
    absentSet: new Set(),
  });
  assert.ok(conflicts.includes(CONFLICT.ALL_WEEK_HELD));
});

test('Plan X：Plan Y 預備隊排在無衝突候選人的最前面', () => {
  const { byId, staff, morning } = fixture();
  const rows = [
    row({ detail_id: 90, staff_id: 9, is_plan_b_standby: true }),
    row({ detail_id: 91, staff_id: 10, is_plan_b_standby: true }),
  ];
  const result = recommendReplacements({
    staff,
    targetItem: morning[0],
    targetDay: 1,
    rows,
    itemsById: byId,
    stats: new Map(),
    absences: [],
    weekStartDate: WEEK,
    excludeStaffId: 1,
  });
  assert.deepEqual(result.slice(0, 2).map((c) => c.staff_id).sort((a, b) => a - b), [9, 10]);
  assert.ok(result[0].is_standby);
});

test('Plan X：有衝突者一律排在無衝突者之後', () => {
  const { byId, staff, morning } = fixture();
  // 預備隊成員 9 當天已在別的早修點位 → 有衝突
  const rows = [
    row({ detail_id: 90, staff_id: 9, is_plan_b_standby: true }),
    row({ detail_id: 1, staff_id: 9, item_id: morning[1].item_id, day_of_week: 1 }),
  ];
  const result = recommendReplacements({
    staff,
    targetItem: morning[0],
    targetDay: 1,
    rows,
    itemsById: byId,
    stats: new Map(),
    absences: [],
    weekStartDate: WEEK,
    limit: 10,
  });
  assert.ok(result[0].conflicts.length === 0);
  const nine = result.find((c) => c.staff_id === 9);
  assert.ok(result.indexOf(nine) > 0);
  assert.ok(nine.conflicts.some((c) => c === CONFLICT.DUPLICATE_SHIFT));
});

test('Plan X：無衝突者之間依該時段歷史次數由少到多排序', () => {
  const { byId, staff, morning } = fixture();
  const stats = new Map(staff.map((s) => [s.staff_id, {
    blackboard_count: 0,
    morning_whiteboard_count: s.staff_id === 6 ? 0 : 30,
    noon_whiteboard_count: 0,
  }]));
  const result = recommendReplacements({
    staff, targetItem: morning[0], targetDay: 1, rows: [], itemsById: byId, stats, absences: [], weekStartDate: WEEK,
  });
  assert.equal(result[0].staff_id, 6);
});

test('Plan X：已在同一名額的人不會被列入候選', () => {
  const { byId, staff, morning } = fixture();
  const rows = [row({ detail_id: 1, staff_id: 3, item_id: morning[0].item_id, day_of_week: 1 })];
  const result = recommendReplacements({
    staff, targetItem: morning[0], targetDay: 1, rows, itemsById: byId, stats: new Map(), absences: [], weekStartDate: WEEK,
  });
  assert.ok(!result.some((c) => c.staff_id === 3));
});

test('Plan X：當日有公差者被標記衝突並排在後面', () => {
  const { byId, staff, morning } = fixture();
  const result = recommendReplacements({
    staff,
    targetItem: morning[0],
    targetDay: 3,
    rows: [],
    itemsById: byId,
    stats: new Map(),
    absences: [{ staff_id: 2, absence_date: '2026-09-09' }],
    weekStartDate: WEEK,
    limit: 10,
  });
  const two = result.find((c) => c.staff_id === 2);
  assert.ok(two.conflicts.includes(CONFLICT.ABSENT));
  assert.ok(result.indexOf(two) > 0);
});

test('Plan X：limit 會先保留無衝突者，衝突者被截斷', () => {
  const { byId, staff, morning } = fixture();
  const rows = [row({ detail_id: 1, staff_id: 9, item_id: morning[1].item_id, day_of_week: 1 })];
  const result = recommendReplacements({
    staff, targetItem: morning[0], targetDay: 1, rows, itemsById: byId,
    stats: new Map(), absences: [], weekStartDate: WEEK, limit: 3,
  });
  assert.equal(result.length, 3);
  assert.ok(result.every((c) => c.conflicts.length === 0));
});

test('徒弟不會出現在補位推薦名單', () => {
  const { byId, morning } = fixture();
  const staff = makeStaff(12, { apprentices: 5 });
  const result = recommendReplacements({
    staff, targetItem: morning[0], targetDay: 1, rows: [], itemsById: byId,
    stats: new Map(), absences: [], weekStartDate: WEEK, limit: 20,
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
    targetDay: 1,
    index: buildBoardIndex([], byId),
    absentSet: new Set(),
  });
  assert.ok(conflicts.includes(CONFLICT.APPRENTICE));
});

test('師傅放進名額不算角色衝突', () => {
  const { byId, morning } = fixture();
  const master = makeStaff(12, { apprentices: 5 })[0];
  const conflicts = checkConflicts({
    candidate: master,
    targetItem: morning[0],
    targetDay: 1,
    index: buildBoardIndex([], byId),
    absentSet: new Set(),
  });
  assert.deepEqual(conflicts, []);
});
