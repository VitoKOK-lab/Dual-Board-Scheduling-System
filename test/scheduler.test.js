import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWeeklyPlan } from '../src/domain/scheduler.js';
import { BOARD, LEADER_GROUP, MEMBER_GROUP, SHIFT, WARNING, WEEK_DAYS } from '../src/domain/constants.js';
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

// ---------------------------------------------------------------
// 帶班制（高二帶高一）：白板每點第 1 個名額是帶班位
// ---------------------------------------------------------------

test('帶班位一律由帶班組擔任，一般位一律由被帶組擔任', () => {
  const { plan, byId } = run({ staff: makeStaff(30) });
  const groupOf = new Map(makeStaff(30).map((s) => [s.staff_id, s.staff_group]));

  for (const a of placed(plan)) {
    const item = byId.get(a.item_id);
    if (item.board_type !== BOARD.WHITEBOARD) continue;
    if (a.slot_role === 'LEADER') {
      assert.equal(groupOf.get(a.staff_id), LEADER_GROUP, `帶班位被 ${groupOf.get(a.staff_id)} 佔用`);
    } else {
      assert.equal(groupOf.get(a.staff_id), MEMBER_GROUP, `一般位被 ${groupOf.get(a.staff_id)} 佔用`);
    }
  }
});

test('帶班組不足時，帶班位留空並回報 NO_LEADER，絕不由被帶組頂替', () => {
  // 只有 1 位帶班組，但每天早修有 4 個點位各需 1 位帶班
  const staff = makeStaff(30, { leaders: 1 });
  const { plan, byId } = run({ staff });
  const groupOf = new Map(staff.map((s) => [s.staff_id, s.staff_group]));

  const leaderGaps = plan.assignments.filter((a) => a.slot_role === 'LEADER' && a.staff_id == null);
  assert.ok(leaderGaps.length > 0, '帶班組不足時應留下空缺');
  assert.ok(plan.warnings.some((w) => w.code === WARNING.NO_LEADER));

  for (const a of placed(plan)) {
    if (byId.get(a.item_id).board_type !== BOARD.WHITEBOARD) continue;
    if (a.slot_role === 'LEADER') assert.equal(groupOf.get(a.staff_id), LEADER_GROUP);
  }
});

test('被帶組不足時，一般位才放寬給帶班組並標記', () => {
  // 帶班組充裕、被帶組極少
  const staff = makeStaff(12, { leaders: 10 });
  const { plan, byId } = run({ staff });
  const groupOf = new Map(staff.map((s) => [s.staff_id, s.staff_group]));

  const relaxed = placed(plan).filter((a) => byId.get(a.item_id).board_type === BOARD.WHITEBOARD
    && a.slot_role === 'MEMBER' && groupOf.get(a.staff_id) === LEADER_GROUP);
  assert.ok(relaxed.length > 0, '被帶組不足時一般位應由帶班組頂替');
  assert.ok(plan.warnings.some((w) => w.code === WARNING.CONSTRAINT_RELAXED));
});

test('Plan Y 預備隊只從被帶組挑選，且整週完全不排班（含黑板）', () => {
  const { plan } = run({ staff: makeStaff(30) });
  const groupOf = new Map(makeStaff(30).map((s) => [s.staff_id, s.staff_group]));
  const assigned = new Set(placed(plan).map((a) => a.staff_id));

  assert.ok(plan.standby.length >= 2);
  for (const id of plan.standby) {
    assert.equal(groupOf.get(id), MEMBER_GROUP);
    assert.ok(!assigned.has(id), '預備隊不應出現在任何名額，包含黑板任務');
  }
});

test('待命權輪替：擔任過預備隊者，下次會讓給待命次數更少的人', () => {
  const staff = makeStaff(30);
  const members = staff.filter((s) => s.staff_group === MEMBER_GROUP);
  const rested = members.slice(0, 3).map((s) => s.staff_id);

  // 這 3 人已待命過 1 次，且累計工作量最低（若只看工作量會再度被選中）
  const stats = new Map(staff.map((s) => [s.staff_id, {
    blackboard_count: 0,
    morning_whiteboard_count: rested.includes(s.staff_id) ? 0 : 10,
    noon_whiteboard_count: 0,
    standby_count: rested.includes(s.staff_id) ? 1 : 0,
  }]));

  const { plan } = run({ staff, stats });
  for (const id of rested) {
    assert.ok(!plan.standby.includes(id), '待命次數較多的人不應再次被選為預備隊');
  }
});

test('待命次數相同時，讓累計工作量最重的人休息', () => {
  const staff = makeStaff(30);
  const members = staff.filter((s) => s.staff_group === MEMBER_GROUP);
  const busiest = members[members.length - 1].staff_id;

  const stats = new Map(staff.map((s) => [s.staff_id, {
    blackboard_count: 0,
    morning_whiteboard_count: s.staff_id === busiest ? 99 : 1,
    noon_whiteboard_count: 0,
    standby_count: 0,
  }]));

  const { plan } = run({ staff, stats });
  assert.ok(plan.standby.includes(busiest), '負擔最重者應優先獲得待命週');
});
