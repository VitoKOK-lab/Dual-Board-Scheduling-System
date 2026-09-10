import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWeeklyPlan } from '../src/domain/scheduler.js';
import { BOARD, SHIFT, WARNING, WEEK_DAYS } from '../src/domain/constants.js';
import { indexItems, makeItems, makeStaff } from './helpers.js';

const WEEK = '2026-09-07';

function run(overrides = {}) {
  const staff = overrides.staff ?? makeStaff(20);
  const items = overrides.items ?? makeItems();
  const plan = generateWeeklyPlan({
    staff,
    items,
    stats: overrides.stats ?? new Map(),
    absences: overrides.absences ?? [],
    weekStartDate: overrides.weekStartDate ?? WEEK,
    standbyCount: overrides.standbyCount ?? 3,
  });
  return { plan, staff, items, byId: indexItems(items) };
}

const placed = (plan) => plan.assignments.filter((a) => a.staff_id != null && !a.is_plan_b_standby);

test('每個點位的每個名額都被生成，且黑板全週職務不綁定星期', () => {
  const { plan, items } = run();
  const dailySlots = items
    .filter((i) => i.shift_type !== SHIFT.ALL_WEEK)
    .reduce((sum, i) => sum + i.required_capacity, 0) * WEEK_DAYS.length;
  const weekSlots = items.filter((i) => i.shift_type === SHIFT.ALL_WEEK)
    .reduce((sum, i) => sum + i.required_capacity, 0);

  const nonStandby = plan.assignments.filter((a) => !a.is_plan_b_standby);
  assert.equal(nonStandby.length, dailySlots + weekSlots);

  for (const a of nonStandby) {
    const item = indexItems(items).get(a.item_id);
    if (item.shift_type === SHIFT.ALL_WEEK) assert.equal(a.day_of_week, null);
    else assert.ok(WEEK_DAYS.includes(a.day_of_week));
  }
});

test('硬性限制：同一人當天的早修點位不會等於午休點位', () => {
  const { plan, byId } = run();
  const morning = new Map();
  for (const a of placed(plan)) {
    const item = byId.get(a.item_id);
    if (item.board_type === BOARD.WHITEBOARD && item.shift_type === SHIFT.MORNING) {
      morning.set(`${a.staff_id}:${a.day_of_week}`, item.item_name);
    }
  }
  for (const a of placed(plan)) {
    const item = byId.get(a.item_id);
    if (item.board_type === BOARD.WHITEBOARD && item.shift_type === SHIFT.NOON) {
      assert.notEqual(morning.get(`${a.staff_id}:${a.day_of_week}`), item.item_name,
        `${a.staff_id} 在週${a.day_of_week} 的早修與午休都排在 ${item.item_name}`);
    }
  }
});

test('硬性限制：同一人同一天在同一個時段不會被排兩個點位', () => {
  const { plan, byId } = run();
  for (const shift of [SHIFT.MORNING, SHIFT.NOON]) {
    const seen = new Set();
    for (const a of placed(plan)) {
      const item = byId.get(a.item_id);
      if (item.board_type !== BOARD.WHITEBOARD || item.shift_type !== shift) continue;
      const key = `${a.staff_id}:${a.day_of_week}`;
      assert.ok(!seen.has(key), `${a.staff_id} 在週${a.day_of_week} 的 ${shift} 被排了兩次`);
      seen.add(key);
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

test('公差：登錄當日的人員不會被排入該日任何名額', () => {
  const absences = [{ staff_id: 3, absence_date: '2026-09-09' }]; // 週三
  const { plan } = run({ absences });
  const onWednesday = placed(plan).filter((a) => a.day_of_week === 3 && a.staff_id === 3);
  assert.equal(onWednesday.length, 0);
});

test('公差：整週皆有公差者不會被指派全週固定職務', () => {
  const absences = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']
    .map((d) => ({ staff_id: 1, absence_date: d }));
  const { plan, byId } = run({ absences });
  const allWeek = placed(plan).filter((a) => byId.get(a.item_id).shift_type === SHIFT.ALL_WEEK);
  assert.ok(allWeek.every((a) => a.staff_id !== 1));
});

test('Plan Y：選出 2~3 名預備隊，且皆為在職人員', () => {
  const { plan, staff } = run();
  assert.ok(plan.standby.length >= 2 && plan.standby.length <= 3);
  assert.equal(new Set(plan.standby).size, plan.standby.length);
  for (const id of plan.standby) {
    assert.ok(staff.find((s) => s.staff_id === id)?.is_active);
  }
});

test('Plan Y：優先選出本週被指派次數最少的人', () => {
  const { plan } = run();
  const load = new Map();
  for (const a of placed(plan)) load.set(a.staff_id, (load.get(a.staff_id) ?? 0) + 1);
  const standbyMax = Math.max(...plan.standby.map((id) => load.get(id) ?? 0));
  const overallMin = Math.min(...[...load.values()]);
  assert.ok(standbyMax <= overallMin + 1);
});

test('人力不足時保留空缺並回報警告，不會重複指派同一人', () => {
  const { plan, byId } = run({ staff: makeStaff(3) });
  const gaps = plan.assignments.filter((a) => a.staff_id == null && !a.is_plan_b_standby);
  assert.ok(gaps.length > 0);
  assert.ok(plan.warnings.some((w) => w.code === WARNING.UNDERSTAFFED));

  const seen = new Set();
  for (const a of placed(plan)) {
    const item = byId.get(a.item_id);
    if (item.board_type !== BOARD.WHITEBOARD || item.shift_type !== SHIFT.MORNING) continue;
    const key = `${a.staff_id}:${a.day_of_week}`;
    assert.ok(!seen.has(key));
    seen.add(key);
  }
});

test('停用人員不會出現在任何名額或預備隊', () => {
  const staff = makeStaff(20);
  staff[0].is_active = false;
  const { plan } = run({ staff });
  assert.ok(placed(plan).every((a) => a.staff_id !== 1));
  assert.ok(!plan.standby.includes(1));
});

test('決定性：相同輸入必產生完全相同的班表', () => {
  const a = run().plan;
  const b = run().plan;
  assert.deepEqual(a.assignments, b.assignments);
  assert.deepEqual(a.standby, b.standby);
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
