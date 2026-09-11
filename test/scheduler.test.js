import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWeeklyPlan } from '../src/domain/scheduler.js';
import { BOARD, ROLE, SHIFT, WARNING, WEEK_DAYS } from '../src/domain/constants.js';
import { indexItems, makeItems, makeStaff, slotsIn } from './helpers.js';

const WEEK = '2026-09-07';

function run(overrides = {}) {
  const staff = overrides.staff ?? makeStaff(20);
  const items = overrides.items ?? makeItems();
  const plan = generateWeeklyPlan({
    staff,
    items,
    stats: overrides.stats ?? new Map(),
    weekStartDate: overrides.weekStartDate ?? WEEK,
    flagDays: overrides.flagDays ?? [],
  });
  return { plan, staff, items, byId: indexItems(items) };
}

const placed = (plan) => plan.assignments.filter((a) => a.staff_id != null);

test('黑板依星期展開、白板依週指派，公差完全不由排班引擎產生', () => {
  const { plan, items, byId } = run();

  const allWeek = slotsIn(items, BOARD.BLACKBOARD, SHIFT.ALL_WEEK);
  const daily = slotsIn(items, BOARD.BLACKBOARD, SHIFT.DAILY) * WEEK_DAYS.length;
  const morning = slotsIn(items, BOARD.WHITEBOARD, SHIFT.MORNING);
  const noon = slotsIn(items, BOARD.WHITEBOARD, SHIFT.NOON);

  assert.equal(plan.assignments.length, allWeek + daily + morning + noon);

  for (const a of plan.assignments) {
    const item = byId.get(a.item_id);
    assert.notEqual(item.board_type, BOARD.SPECIAL, '公差由主管手動指派，不該被自動排班產生');
    // 只有黑板每日職務綁定星期；白板早修午休是整週同一人
    if (item.board_type === BOARD.BLACKBOARD && item.shift_type === SHIFT.DAILY) {
      assert.ok(WEEK_DAYS.includes(a.day_of_week));
    } else {
      assert.equal(a.day_of_week, null);
    }
  }
});

test('沒有指定升旗日時，升旗整塊是空的', () => {
  const { plan, byId } = run();
  const flag = plan.assignments.filter((a) => byId.get(a.item_id).shift_type === SHIFT.FLAG);
  assert.equal(flag.length, 0);
  assert.deepEqual(plan.flagDays, []);
});

test('指定升旗日後，當天所有升旗名額都排上人', () => {
  const { plan, items, byId } = run({ staff: makeStaff(30), flagDays: [3] });
  const flag = plan.assignments.filter((a) => byId.get(a.item_id).shift_type === SHIFT.FLAG);

  assert.equal(flag.length, slotsIn(items, BOARD.WHITEBOARD, SHIFT.FLAG));
  assert.ok(flag.every((a) => a.day_of_week === 3));
  assert.deepEqual(plan.flagDays, [3]);
});

test('一個月三次升旗：指定多天時每天各排一輪，同一天不會有人站兩個點位', () => {
  const { plan, items, byId } = run({ staff: makeStaff(30), flagDays: [1, 3, 5] });
  const flag = plan.assignments.filter((a) => byId.get(a.item_id).shift_type === SHIFT.FLAG);

  assert.equal(flag.length, slotsIn(items, BOARD.WHITEBOARD, SHIFT.FLAG) * 3);
  const seen = new Set();
  for (const a of flag.filter((x) => x.staff_id != null)) {
    const key = `${a.staff_id}:${a.day_of_week}`;
    assert.ok(!seen.has(key), `${a.staff_id} 在週${a.day_of_week} 的升旗被排了兩次`);
    seen.add(key);
  }
});

test('升旗日以外的日期不會冒出升旗名額', () => {
  const { plan, byId } = run({ staff: makeStaff(30), flagDays: [2] });
  const flag = plan.assignments.filter((a) => byId.get(a.item_id).shift_type === SHIFT.FLAG);
  assert.ok(flag.every((a) => a.day_of_week === 2));
});

test('依週指派：同一時段裡一個人只會有一個點位', () => {
  const { plan, byId } = run({ staff: makeStaff(30) });
  for (const shift of [SHIFT.MORNING, SHIFT.NOON]) {
    const seen = new Set();
    for (const a of placed(plan)) {
      const item = byId.get(a.item_id);
      if (item.board_type !== BOARD.WHITEBOARD || item.shift_type !== shift) continue;
      assert.ok(!seen.has(a.staff_id), `${a.staff_id} 在 ${shift} 被排了兩個點位`);
      seen.add(a.staff_id);
    }
  }
});

test('硬性限制：同一人本週的早修點位不會等於午休點位', () => {
  const { plan, byId } = run({ staff: makeStaff(30) });
  const morning = new Map();
  for (const a of placed(plan)) {
    const item = byId.get(a.item_id);
    if (item.board_type === BOARD.WHITEBOARD && item.shift_type === SHIFT.MORNING) {
      morning.set(a.staff_id, item.item_name);
    }
  }
  for (const a of placed(plan)) {
    const item = byId.get(a.item_id);
    if (item.board_type === BOARD.WHITEBOARD && item.shift_type === SHIFT.NOON) {
      assert.notEqual(morning.get(a.staff_id), item.item_name,
        `${a.staff_id} 的早修與午休都排在 ${item.item_name}`);
    }
  }
});

test('同一人同一天不會被排兩項黑板每日職務', () => {
  const { plan, byId } = run();
  const seen = new Set();
  for (const a of placed(plan)) {
    const item = byId.get(a.item_id);
    if (item.board_type !== BOARD.BLACKBOARD || item.shift_type !== SHIFT.DAILY) continue;
    const key = `${a.staff_id}:${a.day_of_week}`;
    assert.ok(!seen.has(key), `${a.staff_id} 在週${a.day_of_week} 有兩項黑板任務`);
    seen.add(key);
  }
});

test('公平性：歷史次數最少者優先被指派黑板職務', () => {
  const staff = makeStaff(20);
  const stats = new Map(staff.map((s) => [s.staff_id, {
    blackboard_count: s.staff_id === 20 ? 0 : 50,
    morning_whiteboard_count: 0,
    noon_whiteboard_count: 0,
  }]));
  const { plan, byId } = run({ staff, stats });

  const first = placed(plan).find((a) => byId.get(a.item_id).board_type === BOARD.BLACKBOARD);
  assert.equal(first.staff_id, 20, '黑板次數為 0 的人員應最先被抽出');
});

test('公平性：一輪生成後，早修次數的最大差距不超過 1', () => {
  const { plan, byId } = run({ staff: makeStaff(20) });
  const counts = new Map();
  for (const a of placed(plan)) {
    const item = byId.get(a.item_id);
    if (item.board_type === BOARD.WHITEBOARD && item.shift_type === SHIFT.MORNING) {
      counts.set(a.staff_id, (counts.get(a.staff_id) ?? 0) + 1);
    }
  }
  const values = [...counts.values()];
  assert.ok(Math.max(...values) - Math.min(...values) <= 1);
});

test('人力不足時保留空缺並回報警告，不會重複指派同一人', () => {
  const { plan, byId } = run({ staff: makeStaff(3) });
  const gaps = plan.assignments.filter((a) => a.staff_id == null);
  assert.ok(gaps.length > 0);
  assert.ok(plan.warnings.some((w) => w.code === WARNING.UNDERSTAFFED));

  const seen = new Set();
  for (const a of placed(plan)) {
    const item = byId.get(a.item_id);
    if (item.board_type !== BOARD.WHITEBOARD || item.shift_type !== SHIFT.MORNING) continue;
    assert.ok(!seen.has(a.staff_id));
    seen.add(a.staff_id);
  }
});

test('決定性：相同輸入必產生完全相同的班表', () => {
  const a = run({ flagDays: [3] }).plan;
  const b = run({ flagDays: [3] }).plan;
  assert.deepEqual(a.assignments, b.assignments);
});

test('週別輪轉：不同週的平手順序會位移，避免固定同一批人吃虧', () => {
  const staff = makeStaff(20);
  const w1 = generateWeeklyPlan({ staff, items: makeItems(), weekStartDate: '2026-09-07' });
  const w2 = generateWeeklyPlan({ staff, items: makeItems(), weekStartDate: '2026-09-14' });
  assert.notDeepEqual(
    w1.assignments.map((a) => a.staff_id),
    w2.assignments.map((a) => a.staff_id),
  );
});

test('缺少 weekStartDate 時直接拋錯', () => {
  assert.throws(() => generateWeeklyPlan({ staff: makeStaff(5), items: makeItems() }), /weekStartDate/);
});

// ---------------------------------------------------------------
// 師徒制：只有師傅進入排班池
// ---------------------------------------------------------------

test('徒弟完全不會被排班', () => {
  const staff = makeStaff(30, { apprentices: 12 });
  const { plan } = run({ staff });
  const roleOf = new Map(staff.map((s) => [s.staff_id, s.role]));

  assert.ok(placed(plan).length > 0);
  for (const a of placed(plan)) {
    assert.equal(roleOf.get(a.staff_id), ROLE.MASTER, `徒弟 ${a.staff_id} 被排到班`);
  }
});

test('把徒弟升級為師傅後，他才會進入排班池', () => {
  const before = makeStaff(20, { apprentices: 8 });
  const promoted = before.map((s) => ({ ...s, role: ROLE.MASTER }));

  const planBefore = run({ staff: before }).plan;
  const planAfter = run({ staff: promoted }).plan;

  const rookie = before.at(-1).staff_id;
  assert.ok(!placed(planBefore).some((a) => a.staff_id === rookie));
  assert.ok(placed(planAfter).some((a) => a.staff_id === rookie));
});

test('停用的師傅不會被排班', () => {
  const staff = makeStaff(20);
  staff[0].is_active = false;
  const { plan } = run({ staff });
  assert.ok(placed(plan).every((a) => a.staff_id !== 1));
});

// ---------------------------------------------------------------
// 容量上限：白板依週指派，一個時段每人只能站一個點位
// ---------------------------------------------------------------

test('單一時段名額數超過師傅數時回報 CAPACITY_EXCEEDED 並留下空缺', () => {
  // 6 位師傅，早修 4 點位 × 2 人 = 8 個名額
  const { plan } = run({ staff: makeStaff(6), items: makeItems({ capacity: 2 }) });

  const exceeded = plan.warnings.filter((w) => w.code === WARNING.CAPACITY_EXCEEDED);
  assert.ok(exceeded.length > 0);
  assert.equal(exceeded[0].required, 8);
  assert.ok(exceeded[0].shortfall > 0);
  assert.ok(plan.assignments.some((a) => a.staff_id == null));
});

test('升旗定點與巡查合起來計算名額上限，不會分開放寬', () => {
  // 12 位師傅；升旗 8 點 × 2 人 = 16 個名額，必然不足
  const { plan } = run({
    staff: makeStaff(12),
    items: makeItems({ morningPoints: 2, flagPoints: 8, noonPoints: 2, capacity: 2 }),
    flagDays: [3],
  });
  const exceeded = plan.warnings.filter((w) => w.code === WARNING.CAPACITY_EXCEEDED);
  assert.ok(exceeded.some((w) => w.shift_type === SHIFT.FLAG));
  assert.equal(exceeded.find((w) => w.shift_type === SHIFT.FLAG).required, 16);
});

test('沒有升旗日時，升旗點位再多也不會報人力不足', () => {
  const { plan } = run({
    staff: makeStaff(12),
    items: makeItems({ morningPoints: 2, flagPoints: 8, noonPoints: 2, capacity: 2 }),
  });
  const exceeded = plan.warnings.filter((w) => w.code === WARNING.CAPACITY_EXCEEDED);
  assert.ok(!exceeded.some((w) => w.shift_type === SHIFT.FLAG));
});

// ---------------------------------------------------------------
// 三個白板時段：早修 → 升旗 → 午休
// ---------------------------------------------------------------

test('三個時段都會被排班，且升旗的定點與巡查同屬一個時段', () => {
  const { plan, byId } = run({ staff: makeStaff(30), flagDays: [3] });
  const byShift = new Map();
  for (const a of placed(plan)) {
    const item = byId.get(a.item_id);
    if (item.board_type !== BOARD.WHITEBOARD) continue;
    byShift.set(item.shift_type, (byShift.get(item.shift_type) ?? 0) + 1);
  }
  for (const shift of [SHIFT.MORNING, SHIFT.FLAG, SHIFT.NOON]) {
    assert.ok(byShift.get(shift) > 0, `${shift} 沒有任何指派`);
  }

  const zones = new Set(placed(plan)
    .map((a) => byId.get(a.item_id))
    .filter((i) => i.shift_type === SHIFT.FLAG)
    .map((i) => i.zone));
  assert.deepEqual([...zones].sort(), ['定點', '巡查'], '升旗應同時涵蓋定點與巡查');
});

test('升旗次數獨立累計，不會跟早修或午休混在一起', () => {
  const staff = makeStaff(30);
  const stats = new Map(staff.map((s) => [s.staff_id, {
    blackboard_count: 0,
    morning_whiteboard_count: 0,
    flag_whiteboard_count: s.staff_id === 30 ? 0 : 50,
    noon_whiteboard_count: 0,
    special_count: 0,
  }]));
  const { plan, byId } = run({ staff, stats, flagDays: [1, 3, 5] });

  const flagCounts = new Map();
  for (const a of placed(plan)) {
    if (byId.get(a.item_id).shift_type !== SHIFT.FLAG) continue;
    flagCounts.set(a.staff_id, (flagCounts.get(a.staff_id) ?? 0) + 1);
  }
  const mine = flagCounts.get(30) ?? 0;
  assert.equal(mine, Math.max(...flagCounts.values()), '升旗次數為 0 的人應被排到最多升旗');

  // 早修次數大家都是 0，不該因為升旗落後就被多排早修
  const morningCounts = new Map();
  for (const a of placed(plan)) {
    if (byId.get(a.item_id).shift_type !== SHIFT.MORNING) continue;
    morningCounts.set(a.staff_id, (morningCounts.get(a.staff_id) ?? 0) + 1);
  }
  const values = [...morningCounts.values()];
  assert.ok(Math.max(...values) - Math.min(...values) <= 1, '早修應維持自己的平衡');
});

// ---------------------------------------------------------------
// 每個人都要有任務
// ---------------------------------------------------------------

test('名額足夠時，每一位師傅整週都有任務', () => {
  const { plan, staff } = run({ staff: makeStaff(20) });

  const load = new Map();
  for (const a of placed(plan)) load.set(a.staff_id, (load.get(a.staff_id) ?? 0) + 1);

  for (const person of staff.filter((s) => s.is_active)) {
    assert.ok((load.get(person.staff_id) ?? 0) > 0, `${person.name} 整週沒有任何任務`);
  }
  assert.ok(!plan.warnings.some((w) => w.code === WARNING.IDLE_STAFF));
});

test('名額不足以讓每個人都排到時，回報 IDLE_STAFF 並列出是誰', () => {
  // 40 位師傅，但白板整週只有 2 個點位，黑板 5 項
  const { plan } = run({
    staff: makeStaff(40),
    items: makeItems({ morningPoints: 1, flagPoints: 0, noonPoints: 1, capacity: 1 }),
  });

  const idle = plan.warnings.find((w) => w.code === WARNING.IDLE_STAFF);
  assert.ok(idle, '應回報有人整週掛零');
  assert.ok(idle.staff_ids.length > 0);
  assert.equal(idle.staff_ids.length, idle.names.length);

  const load = new Map();
  for (const a of placed(plan)) load.set(a.staff_id, (load.get(a.staff_id) ?? 0) + 1);
  for (const id of idle.staff_ids) {
    assert.equal(load.get(id) ?? 0, 0, '被列為掛零的人不該有任務');
  }
});
