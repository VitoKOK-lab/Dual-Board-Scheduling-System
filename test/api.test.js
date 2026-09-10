import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.js';
import { createApp } from '../src/server/index.js';

const WEEK = '2026-09-07';

async function withServer(fn) {
  const db = openDatabase(':memory:', { seed: true });
  const server = createApp(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, options = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  try {
    await fn({ call, base, db });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
}

test('GET /api/week 對尚未排班的週回傳空班表骨架', async () => {
  await withServer(async ({ call }) => {
    const { status, body } = await call(`/api/week?week=${WEEK}`);
    assert.equal(status, 200);
    assert.equal(body.schedule.week_start_date, WEEK);
    assert.equal(body.schedule.status, 'DRAFT');
    assert.equal(body.schedule.has_items, false);
    assert.equal(body.assignments.length, 0);
    assert.equal(body.staff.length, 69);
    assert.deepEqual(body.groups.map((g) => [g.name, g.total]), [['高一組', 47], ['高二組', 22]]);
  });
});

test('GET /api/week 會把週中任一天收斂到該週週一', async () => {
  await withServer(async ({ call }) => {
    const { body } = await call('/api/week?week=2026-09-10');
    assert.equal(body.schedule.week_start_date, WEEK);
  });
});

test('一鍵排班會填滿所有名額並產生 Plan Y 預備隊', async () => {
  await withServer(async ({ call }) => {
    const { body } = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const standbyIds = new Set(body.standby.map((s) => s.staff_id));
    const load = new Map();
    for (const a of body.assignments) load.set(a.staff_id, (load.get(a.staff_id) ?? 0) + 1);

    assert.equal(load.size + standbyIds.size, 69, '69 人不是排到班就是在預備隊');
    for (const id of standbyIds) {
      assert.ok(!load.has(id), '預備隊整週不應有任何指派');
    }
    assert.equal(body.schedule.has_items, true);
    assert.ok(body.assignments.length > 200);
    assert.ok(body.standby.length >= 2 && body.standby.length <= 3);
    assert.equal(body.warnings.length, 0, '種子資料人力充足，不應有待補名額');
    assert.ok(body.assignments.every((a) => a.staff_id != null));
  });
});

test('草稿狀態不影響公平性統計，發布後才結算', async () => {
  await withServer(async ({ call }) => {
    const gen = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const totalBefore = gen.body.fairness.reduce((s, f) => s + f.blackboard_count + f.morning_whiteboard_count + f.noon_whiteboard_count, 0);
    assert.equal(totalBefore, 0);

    const pub = await call(`/api/schedules/${gen.body.schedule.schedule_id}/publish`, { method: 'POST' });
    assert.equal(pub.body.schedule.status, 'PUBLISHED');
    const totalAfter = pub.body.fairness.reduce((s, f) => s + f.blackboard_count + f.morning_whiteboard_count + f.noon_whiteboard_count, 0);
    assert.equal(totalAfter, gen.body.assignments.length);
  });
});

test('重複發布同一份班表不會重複累加統計', async () => {
  await withServer(async ({ call }) => {
    const gen = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const id = gen.body.schedule.schedule_id;
    const first = await call(`/api/schedules/${id}/publish`, { method: 'POST' });
    const second = await call(`/api/schedules/${id}/publish`, { method: 'POST' });
    assert.deepEqual(
      first.body.fairness.map((f) => [f.staff_id, f.blackboard_count, f.morning_whiteboard_count, f.noon_whiteboard_count]),
      second.body.fairness.map((f) => [f.staff_id, f.blackboard_count, f.morning_whiteboard_count, f.noon_whiteboard_count]),
    );
  });
});

test('撤回發布會沖銷該次結算', async () => {
  await withServer(async ({ call }) => {
    const gen = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const id = gen.body.schedule.schedule_id;
    await call(`/api/schedules/${id}/publish`, { method: 'POST' });
    const back = await call(`/api/schedules/${id}/unpublish`, { method: 'POST' });
    assert.equal(back.body.schedule.status, 'DRAFT');
    const total = back.body.fairness.reduce((s, f) => s + f.blackboard_count + f.morning_whiteboard_count + f.noon_whiteboard_count, 0);
    assert.equal(total, 0);
  });
});

test('手動覆寫會標記 is_override，並在有衝突時回報但不阻擋', async () => {
  await withServer(async ({ call }) => {
    const gen = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const morningItem = gen.body.items.find((i) => i.board_type === 'WHITEBOARD' && i.shift_type === 'MORNING');
    const slots = gen.body.assignments.filter((a) => a.item_id === morningItem.item_id && a.day_of_week === 1);
    const other = gen.body.assignments.find((a) => a.day_of_week === 1 && a.item_id !== morningItem.item_id
      && gen.body.items.find((i) => i.item_id === a.item_id)?.shift_type === 'MORNING');

    const res = await call(`/api/assignments/${slots[0].detail_id}`, {
      method: 'PATCH', body: { staff_id: other.staff_id },
    });
    assert.equal(res.status, 200);
    const updated = res.body.assignments.find((a) => a.detail_id === slots[0].detail_id);
    assert.equal(updated.staff_id, other.staff_id);
    assert.equal(updated.is_override, true);
    assert.ok(res.body.conflicts.some((c) => c.code === 'DUPLICATE_SHIFT'), '應回報同時段重複的衝突');
  });
});

test('清空名額後會出現在待補清單，補位後消失', async () => {
  await withServer(async ({ call }) => {
    const gen = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const slot = gen.body.assignments.find((a) => a.day_of_week === 2);

    const cleared = await call(`/api/assignments/${slot.detail_id}`, { method: 'PATCH', body: { staff_id: null } });
    assert.ok(cleared.body.warnings.some((w) => w.detail_id === slot.detail_id));

    const plan = await call(`/api/assignments/${slot.detail_id}/plan-x`);
    assert.ok(plan.body.candidates.length > 0);
    const best = plan.body.candidates[0];
    assert.equal(best.conflicts.length, 0, '首選候選人不應帶衝突');

    const filled = await call(`/api/assignments/${slot.detail_id}`, { method: 'PATCH', body: { staff_id: best.staff_id } });
    assert.ok(!filled.body.warnings.some((w) => w.detail_id === slot.detail_id));
  });
});

test('互換名牌會對調兩個名額上的人員', async () => {
  await withServer(async ({ call }) => {
    const gen = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const [a, b] = gen.body.assignments.filter((x) => x.day_of_week === 3).slice(0, 2);

    const res = await call('/api/assignments/swap', {
      method: 'POST', body: { detail_id_a: a.detail_id, detail_id_b: b.detail_id },
    });
    const newA = res.body.assignments.find((x) => x.detail_id === a.detail_id);
    const newB = res.body.assignments.find((x) => x.detail_id === b.detail_id);
    assert.equal(newA.staff_id, b.staff_id);
    assert.equal(newB.staff_id, a.staff_id);
  });
});

test('登錄公差後重新排班，該員當日不再被指派', async () => {
  await withServer(async ({ call }) => {
    const staffId = 5;
    await call('/api/absences', {
      method: 'POST',
      body: { staff_id: staffId, absence_date: '2026-09-09', absence_type: 'OFFICIAL', note: '校外研習' },
    });
    const gen = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const onWednesday = gen.body.assignments.filter((a) => a.day_of_week === 3 && a.staff_id === staffId);
    assert.equal(onWednesday.length, 0);
    assert.equal(gen.body.absences.length, 1);
  });
});

test('公差不影響公平性統計的計算方式', async () => {
  await withServer(async ({ call }) => {
    await call('/api/absences', { method: 'POST', body: { staff_id: 5, absence_date: '2026-09-09' } });
    const gen = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const pub = await call(`/api/schedules/${gen.body.schedule.schedule_id}/publish`, { method: 'POST' });
    const total = pub.body.fairness.reduce((s, f) => s + f.blackboard_count + f.morning_whiteboard_count + f.noon_whiteboard_count, 0);
    assert.equal(total, gen.body.assignments.filter((a) => a.staff_id != null).length);
  });
});

test('刪除公差紀錄後清單淨空', async () => {
  await withServer(async ({ call }) => {
    const created = await call('/api/absences', { method: 'POST', body: { staff_id: 8, absence_date: '2026-09-08' } });
    const [absence] = created.body.absences;
    const after = await call(`/api/absences/${absence.absence_id}?week=${WEEK}`, { method: 'DELETE' });
    assert.equal(after.body.absences.length, 0);
  });
});

test('停用人員後重新排班不再指派該員', async () => {
  await withServer(async ({ call }) => {
    await call('/api/staff/1', { method: 'PATCH', body: { is_active: false } });
    const gen = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    assert.ok(gen.body.assignments.every((a) => a.staff_id !== 1));
    assert.ok(!gen.body.standby.some((s) => s.staff_id === 1));
  });
});

test('週次前後切換會落在相鄰的週一', async () => {
  await withServer(async ({ call }) => {
    const next = await call(`/api/week/navigate?week=${WEEK}&delta=1`);
    assert.equal(next.body.schedule.week_start_date, '2026-09-14');
    const prev = await call(`/api/week/navigate?week=${WEEK}&delta=-1`);
    assert.equal(prev.body.schedule.week_start_date, '2026-08-31');
  });
});

test('輸入驗證：錯誤參數回傳 400，未知路徑回傳 404', async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call('/api/week?week=2026-9-7')).status, 400);
    assert.equal((await call('/api/absences', { method: 'POST', body: { staff_id: 1, absence_date: 'tomorrow' } })).status, 400);
    assert.equal((await call('/api/staff', { method: 'POST', body: { name: '  ' } })).status, 400);
    assert.equal((await call('/api/nope')).status, 404);
    assert.equal((await call('/api/assignments/999999/plan-x')).status, 404);
  });
});

test('新增人員會同步建立公平性統計列並保留組別', async () => {
  await withServer(async ({ call }) => {
    const res = await call('/api/staff', { method: 'POST', body: { name: '新進同仁', staff_group: '高二組' } });
    const list = await call('/api/staff');
    const row = list.body.fairness.find((f) => f.staff_id === res.body.staff_id);
    assert.equal(row.name, '新進同仁');
    assert.equal(row.staff_group, '高二組');
    assert.equal(row.blackboard_count, 0);
    assert.equal(list.body.staff.at(-1).staff_id, res.body.staff_id, '新人應排在名冊最後');
  });
});

test('靜態前端可正常提供', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /雙板排班/);
  });
});

test('白板每個點位的帶班位只由高二組擔任，一般位以高一組為主', async () => {
  await withServer(async ({ call }) => {
    const { body } = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const items = new Map(body.items.map((i) => [i.item_id, i]));
    const staff = new Map(body.staff.map((s) => [s.staff_id, s]));

    let leaderSlots = 0;
    let memberSlots = 0;
    for (const a of body.assignments) {
      const item = items.get(a.item_id);
      if (!item || item.board_type !== 'WHITEBOARD' || a.staff_id == null) continue;
      const group = staff.get(a.staff_id).staff_group;
      if (a.slot_role === 'LEADER') {
        leaderSlots += 1;
        assert.equal(group, '高二組', `${staff.get(a.staff_id).name} 不是高二組卻站了帶班位`);
      } else {
        memberSlots += 1;
        assert.equal(group, '高一組', `${staff.get(a.staff_id).name} 不是高一組卻站了一般位`);
      }
    }
    assert.equal(leaderSlots, 100, '早修 10 點 + 午休 10 點 × 5 天 = 100 個帶班位');
    assert.ok(memberSlots > 0);
  });
});

test('每個白板點位每天都有帶班組人員', async () => {
  await withServer(async ({ call }) => {
    const { body } = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const items = new Map(body.items.map((i) => [i.item_id, i]));
    const staff = new Map(body.staff.map((s) => [s.staff_id, s]));

    const byPoint = new Map();
    for (const a of body.assignments) {
      const item = items.get(a.item_id);
      if (!item || item.board_type !== 'WHITEBOARD') continue;
      const key = `${item.shift_type}/${item.item_name}/${a.day_of_week}`;
      if (!byPoint.has(key)) byPoint.set(key, []);
      byPoint.get(key).push(a.staff_id == null ? null : staff.get(a.staff_id).staff_group);
    }
    assert.equal(byPoint.size, 100);
    for (const [key, groups] of byPoint) {
      assert.ok(groups.includes('高二組'), `${key} 沒有高二組帶班`);
    }
  });
});

test('預備隊只從高一組挑選，且整週完全不排班', async () => {
  await withServer(async ({ call }) => {
    const { body } = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const staff = new Map(body.staff.map((s) => [s.staff_id, s]));
    const assigned = new Set(body.assignments.filter((a) => a.staff_id != null).map((a) => a.staff_id));

    assert.ok(body.standby.length >= 2);
    for (const s of body.standby) {
      assert.equal(staff.get(s.staff_id).staff_group, '高一組');
      assert.ok(!assigned.has(s.staff_id), `${staff.get(s.staff_id).name} 是預備隊卻仍被排班`);
    }
  });
});

test('待命次數會輪替：連續數週不會重複選到同一批預備隊', async () => {
  await withServer(async ({ call }) => {
    const weeks = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'];
    const picked = [];
    for (const week of weeks) {
      const gen = await call('/api/week/generate', { method: 'POST', body: { week } });
      await call(`/api/schedules/${gen.body.schedule.schedule_id}/publish`, { method: 'POST' });
      picked.push(gen.body.standby.map((s) => s.staff_id));
    }
    const flat = picked.flat();
    assert.equal(new Set(flat).size, flat.length, '同一人不應在四週內重複擔任預備隊');

    const fair = (await call('/api/staff')).body.fairness;
    assert.equal(fair.reduce((sum, f) => sum + f.standby_count, 0), flat.length, '待命次數應等於累計人次');
  });
});

test('帶班位的 Plan X 只推薦高二組', async () => {
  await withServer(async ({ call }) => {
    const gen = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const leaderSlot = gen.body.assignments.find((a) => a.slot_role === 'LEADER' && a.day_of_week === 2);

    const plan = await call(`/api/assignments/${leaderSlot.detail_id}/plan-x`);
    assert.equal(plan.body.slot_role, 'LEADER');
    assert.ok(plan.body.candidates.length > 0);
    for (const c of plan.body.candidates) {
      assert.equal(c.staff_group, '高二組', `${c.name} 不是高二組卻出現在帶班位候選名單`);
    }
  });
});

test('帶班位被清空時，待補清單會標記為缺帶班', async () => {
  await withServer(async ({ call }) => {
    const gen = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const leaderSlot = gen.body.assignments.find((a) => a.slot_role === 'LEADER' && a.day_of_week === 4);

    const cleared = await call(`/api/assignments/${leaderSlot.detail_id}`, { method: 'PATCH', body: { staff_id: null } });
    const gap = cleared.body.warnings.find((w) => w.detail_id === leaderSlot.detail_id);
    assert.equal(gap.code, 'NO_LEADER');
    assert.equal(gap.slot_role, 'LEADER');
  });
});

test('把高一組強制指派到帶班位會回報衝突但仍然照做', async () => {
  await withServer(async ({ call }) => {
    const gen = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const leaderSlot = gen.body.assignments.find((a) => a.slot_role === 'LEADER' && a.day_of_week === 5);
    const junior = gen.body.staff.find((s) => s.staff_group === '高一組');

    const res = await call(`/api/assignments/${leaderSlot.detail_id}`, { method: 'PATCH', body: { staff_id: junior.staff_id } });
    assert.ok(res.body.conflicts.some((c) => c.code === 'NOT_LEADER'), '應回報帶班位組別不符');
    const updated = res.body.assignments.find((a) => a.detail_id === leaderSlot.detail_id);
    assert.equal(updated.staff_id, junior.staff_id, '主管的強制覆寫仍須生效');
  });
});

test('預備隊次數計入 standby_count，不計入工作量', async () => {
  await withServer(async ({ call }) => {
    const gen = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const pub = await call(`/api/schedules/${gen.body.schedule.schedule_id}/publish`, { method: 'POST' });

    for (const s of gen.body.standby) {
      const row = pub.body.fairness.find((f) => f.staff_id === s.staff_id);
      assert.equal(row.standby_count, 1);
      assert.equal(row.blackboard_count + row.morning_whiteboard_count + row.noon_whiteboard_count, 0);
    }
  });
});
