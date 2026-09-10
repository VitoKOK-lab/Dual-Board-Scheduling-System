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
    assert.deepEqual(body.groups.map((g) => [g.name, g.total, g.master_total]), [['高一組', 47, 0], ['高二組', 22, 22]]);
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

    assert.equal(load.size + standbyIds.size, 22, '22 位師傅不是排到班就是在預備隊');
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
    const staffId = 48; // 名冊中第一位師傅
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
    await call('/api/absences', { method: 'POST', body: { staff_id: 48, absence_date: '2026-09-09' } });
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
    const master = (await call('/api/staff')).body.staff.find((s) => s.role === 'MASTER');
    await call(`/api/staff/${master.staff_id}`, { method: 'PATCH', body: { is_active: false } });
    const gen = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    assert.ok(gen.body.assignments.every((a) => a.staff_id !== master.staff_id));
    assert.ok(!gen.body.standby.some((s) => s.staff_id === master.staff_id));
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
    const res = await call('/api/staff', { method: 'POST', body: { name: '新進同仁', staff_group: '高二組', role: 'MASTER' } });
    const list = await call('/api/staff');
    const row = list.body.fairness.find((f) => f.staff_id === res.body.staff_id);
    assert.equal(row.name, '新進同仁');
    assert.equal(row.staff_group, '高二組');
    assert.equal(row.role, 'MASTER');
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

test('只有師傅會被排班，徒弟完全不出現在班表', async () => {
  await withServer(async ({ call }) => {
    const { body } = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const staff = new Map(body.staff.map((s) => [s.staff_id, s]));

    assert.equal(body.staff.filter((s) => s.role === 'MASTER').length, 22);
    assert.equal(body.staff.filter((s) => s.role === 'APPRENTICE').length, 47);

    for (const a of body.assignments) {
      if (a.staff_id == null) continue;
      assert.equal(staff.get(a.staff_id).role, 'MASTER', `${staff.get(a.staff_id).name} 是徒弟卻被排到班`);
    }
    for (const s of body.standby) {
      assert.equal(staff.get(s.staff_id).role, 'MASTER', '預備隊也只能是師傅');
    }
  });
});

test('供需摘要反映「單一時段名額數不得超過師傅數」', async () => {
  await withServer(async ({ call }) => {
    const { body } = await call(`/api/week?week=${WEEK}`);
    const cap = body.capacity;

    assert.equal(cap.masters, 22);
    assert.equal(cap.peak_slots, Math.max(cap.morning_slots, cap.noon_slots));
    assert.equal(cap.headroom, cap.masters - cap.peak_slots);
    assert.equal(cap.feasible, cap.peak_slots <= cap.masters);
    assert.equal(cap.standby_capacity, Math.max(0, Math.min(3, cap.headroom)));
  });
});

test('預備隊人數讓位給實際名額，班表不因留待命而出現空缺', async () => {
  await withServer(async ({ call }) => {
    const { body } = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    assert.equal(body.warnings.length, 0, '不應為了留預備隊而讓名額空著');
    assert.equal(body.standby.length, body.capacity.standby_capacity);
  });
});

test('升級徒弟後，他下次排班就會被指派', async () => {
  await withServer(async ({ call }) => {
    const before = await call(`/api/week?week=${WEEK}`);
    const apprentice = before.body.staff.find((s) => s.role === 'APPRENTICE');

    const promoted = await call(`/api/staff/${apprentice.staff_id}`, { method: 'PATCH', body: { role: 'MASTER' } });
    assert.equal(promoted.body.staff.find((s) => s.staff_id === apprentice.staff_id).role, 'MASTER');

    const gen = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    assert.equal(gen.body.capacity.masters, 23);
    assert.ok(
      gen.body.assignments.some((a) => a.staff_id === apprentice.staff_id)
        || gen.body.standby.some((s) => s.staff_id === apprentice.staff_id),
      '升級後應被排到班或進預備隊',
    );
  });
});

test('降回徒弟後就不再被排班', async () => {
  await withServer(async ({ call }) => {
    const before = await call(`/api/week?week=${WEEK}`);
    const master = before.body.staff.find((s) => s.role === 'MASTER');

    await call(`/api/staff/${master.staff_id}`, { method: 'PATCH', body: { role: 'APPRENTICE' } });
    const gen = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });

    assert.equal(gen.body.capacity.masters, 21);
    assert.ok(!gen.body.assignments.some((a) => a.staff_id === master.staff_id));
    assert.ok(!gen.body.standby.some((s) => s.staff_id === master.staff_id));
  });
});

test('把徒弟強制指派到名額會回報衝突但仍然照做', async () => {
  await withServer(async ({ call }) => {
    const gen = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const slot = gen.body.assignments.find((a) => a.day_of_week === 5 && a.staff_id != null);
    const apprentice = gen.body.staff.find((s) => s.role === 'APPRENTICE');

    const res = await call(`/api/assignments/${slot.detail_id}`, { method: 'PATCH', body: { staff_id: apprentice.staff_id } });
    assert.ok(res.body.conflicts.some((c) => c.code === 'APPRENTICE'), '應回報對方是徒弟');
    const updated = res.body.assignments.find((a) => a.detail_id === slot.detail_id);
    assert.equal(updated.staff_id, apprentice.staff_id, '主管的強制覆寫仍須生效');
  });
});

test('Plan X 候選名單只會出現師傅', async () => {
  await withServer(async ({ call }) => {
    const gen = await call('/api/week/generate', { method: 'POST', body: { week: WEEK } });
    const slot = gen.body.assignments.find((a) => a.day_of_week === 2 && a.staff_id != null);

    const plan = await call(`/api/assignments/${slot.detail_id}/plan-x`);
    assert.ok(plan.body.candidates.length > 0);
    for (const c of plan.body.candidates) {
      assert.equal(c.role, 'MASTER', `${c.name} 是徒弟卻出現在候選名單`);
    }
  });
});

test('待命次數會輪替：連續數週不會重複選到同一批預備隊', async () => {
  await withServer(async ({ call }) => {
    const weeks = ['2026-09-07', '2026-09-14', '2026-09-21'];
    const picked = [];
    for (const week of weeks) {
      const gen = await call('/api/week/generate', { method: 'POST', body: { week } });
      await call(`/api/schedules/${gen.body.schedule.schedule_id}/publish`, { method: 'POST' });
      picked.push(gen.body.standby.map((s) => s.staff_id));
    }
    const flat = picked.flat();
    assert.equal(new Set(flat).size, flat.length, '同一人不應在三週內重複擔任預備隊');

    const fair = (await call('/api/staff')).body.fairness;
    assert.equal(fair.reduce((sum, f) => sum + f.standby_count, 0), flat.length);
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
