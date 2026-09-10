/* ============================================================
   本機 API —— 沿用伺服器版的路徑與回傳格式，
   讓看板程式碼一行都不用改。
   ============================================================ */

const bad = (message) => { throw new Error(message); };

function requireName(value, field = '名稱') {
  const name = String(value ?? '').trim();
  if (!name) bad(`${field}不可為空`);
  if (name.length > 40) bad(`${field}不可超過 40 字`);
  return name;
}

function requireWeek(value) {
  const week = value ?? currentWeekStart();
  if (!isIsoDate(week)) bad('週次格式需為 YYYY-MM-DD');
  return mondayOf(week);
}

async function api(path, { method = 'GET', body } = {}) {
  const url = new URL(path, 'http://local');
  const query = url.searchParams;
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // 去掉 'api'
  const [head, ...rest] = parts;

  /* ---- 週檢視 ---- */
  if (head === 'week' && rest.length === 0 && method === 'GET') {
    const week = requireWeek(query.get('week'));
    await ensureWeekLoaded(week);
    return getWeekView(week);
  }

  if (head === 'week' && rest[0] === 'navigate') {
    const week = requireWeek(query.get('week'));
    const target = shiftWeeks(week, Number(query.get('delta') ?? 0));
    await ensureWeekLoaded(target);
    return getWeekView(target);
  }

  if (head === 'week' && rest[0] === 'generate' && method === 'POST') {
    const week = requireWeek(body?.week);
    await ensureWeekLoaded(week);
    if (STATE.items.length === 0) bad('還沒有任何點位，請先到設定新增');
    if (countMasters() === 0) bad('還沒有可排班的師傅，請先到設定新增或把徒弟升級');
    const view = generate(week, { standbyCount: body?.standby_count ?? STANDBY_MAX });
    await Promise.all([saveWeek(week), saveConfig()]);
    return view;
  }

  /* ---- 發布 / 撤回 ---- */
  if (head === 'schedules' && (rest[1] === 'publish' || rest[1] === 'unpublish')) {
    const week = requireWeek(rest[0]);
    await ensureWeekLoaded(week);
    const view = rest[1] === 'publish' ? publish(week) : unpublish(week);
    await Promise.all([saveWeek(week), saveConfig()]);
    return view;
  }

  /* ---- 名額覆寫 / 互換 / Plan X ---- */
  if (head === 'assignments' && rest[0] === 'swap' && method === 'POST') {
    const view = swapAssignments(Number(body.detail_id_a), Number(body.detail_id_b));
    await Promise.all([saveWeek(view.schedule.week_start_date), saveConfig()]);
    return view;
  }

  if (head === 'assignments' && rest[1] === 'plan-x') {
    return planXRecommendations(Number(rest[0]), { limit: Number(query.get('limit') ?? 8) });
  }

  if (head === 'assignments' && rest.length === 1 && method === 'PATCH') {
    const staffId = body.staff_id === null || body.staff_id === undefined ? null : Number(body.staff_id);
    const view = overrideAssignment(Number(rest[0]), staffId);
    await Promise.all([saveWeek(view.schedule.week_start_date), saveConfig()]);
    return view;
  }

  /* ---- 公差 / 請假 ---- */
  if (head === 'absences' && method === 'POST') {
    if (!isIsoDate(body.absence_date)) bad('日期格式需為 YYYY-MM-DD');
    const type = body.absence_type ?? 'OFFICIAL';
    if (!['OFFICIAL', 'LEAVE'].includes(type)) bad('類型需為公差或請假');

    const week = mondayOf(body.absence_date);
    await ensureWeekLoaded(week);
    const data = ensureWeek(week);
    const staffId = Number(body.staff_id);

    const existing = data.absences.find((a) => a.staff_id === staffId && a.absence_date === body.absence_date);
    if (existing) Object.assign(existing, { absence_type: type, note: body.note ?? null });
    else {
      data.absences.push({
        absence_id: nextId('absence'), staff_id: staffId,
        absence_date: body.absence_date, absence_type: type, note: body.note ?? null,
      });
    }
    await saveWeek(week);
    return getWeekView(week);
  }

  if (head === 'absences' && method === 'DELETE') {
    const week = requireWeek(query.get('week'));
    await ensureWeekLoaded(week);
    const data = ensureWeek(week);
    data.absences = data.absences.filter((a) => a.absence_id !== Number(rest[0]));
    await saveWeek(week);
    return getWeekView(week);
  }

  /* ---- 點位設定 ---- */
  if (head === 'items' && method === 'GET') return { items: sortedItems() };

  if (head === 'items' && method === 'POST') {
    const boardType = body.board_type;
    const shiftType = body.shift_type;
    if (!Object.values(BOARD).includes(boardType)) bad('板別不正確');
    if (boardType === BOARD.WHITEBOARD && !WHITEBOARD_SHIFTS.includes(shiftType)) bad('白板時段需為早修／升旗／午休');
    if (boardType === BOARD.BLACKBOARD && ![SHIFT.ALL_WEEK, SHIFT.DAILY].includes(shiftType)) bad('黑板時段不正確');

    const capacity = Number(body.required_capacity ?? 1);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 20) bad('人數需介於 1~20');

    const zone = String(body.zone ?? '').trim();
    if (zone && !Object.values(ZONE).includes(zone)) bad('分區需為定點或巡查');

    const itemName = requireName(body.item_name, '點位名稱');
    if (STATE.items.some((i) => i.board_type === boardType && i.shift_type === shiftType && i.item_name === itemName)) {
      bad('這個時段已經有同名點位');
    }

    const sameShift = STATE.items.filter((i) => i.board_type === boardType && i.shift_type === shiftType);
    const itemId = nextId('item');
    STATE.items.push({
      item_id: itemId,
      board_type: boardType,
      shift_type: shiftType,
      item_name: itemName,
      required_capacity: capacity,
      zone,
      sort_order: Math.max(0, ...sameShift.map((i) => i.sort_order)) + 10,
    });
    await saveConfig();
    return { item_id: itemId, items: sortedItems() };
  }

  if (head === 'items' && method === 'PATCH') {
    const item = STATE.items.find((i) => i.item_id === Number(rest[0]));
    if (!item) bad('點位不存在');

    if (body.item_name !== undefined) {
      const itemName = requireName(body.item_name, '點位名稱');
      if (STATE.items.some((i) => i.item_id !== item.item_id
        && i.board_type === item.board_type && i.shift_type === item.shift_type && i.item_name === itemName)) {
        bad('這個時段已經有同名點位');
      }
      item.item_name = itemName;
    }
    if (body.required_capacity !== undefined) {
      const capacity = Number(body.required_capacity);
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 20) bad('人數需介於 1~20');
      item.required_capacity = capacity;
    }
    if (body.zone !== undefined) {
      const zone = String(body.zone).trim();
      if (zone && !Object.values(ZONE).includes(zone)) bad('分區需為定點或巡查');
      item.zone = zone;
    }
    if (body.sort_order !== undefined) item.sort_order = Number(body.sort_order);

    await saveConfig();
    return { items: sortedItems() };
  }

  if (head === 'items' && method === 'DELETE') {
    const itemId = Number(rest[0]);
    if (!STATE.items.some((i) => i.item_id === itemId)) bad('點位不存在');

    let removed = 0;
    for (const [week, data] of Object.entries(STATE.weeks)) {
      const before = data.rows.length;
      data.rows = data.rows.filter((r) => r.item_id !== itemId);
      if (data.rows.length !== before) { removed += before - data.rows.length; await saveWeek(week); }
    }
    STATE.items = STATE.items.filter((i) => i.item_id !== itemId);
    await saveConfig();
    return { items: sortedItems(), removed_assignments: removed };
  }

  /* ---- 人員設定 ---- */
  if (head === 'staff' && method === 'GET') {
    return { staff: sortedStaff(), groups: listGroups(), fairness: listFairness() };
  }

  if (head === 'staff' && method === 'POST') {
    const role = body.role ?? ROLE.APPRENTICE;
    if (!Object.values(ROLE).includes(role)) bad('身分需為師傅或徒弟');

    const staffId = nextId('staff');
    STATE.staff.push({
      staff_id: staffId,
      name: requireName(body.name, '姓名'),
      staff_group: String(body.staff_group ?? '').trim(),
      role,
      is_active: true,
      sort_order: Math.max(0, ...STATE.staff.map((s) => s.sort_order)) + 1,
    });
    STATE.fairness[staffId] = blankStat();
    await saveConfig();
    return { staff_id: staffId, staff: sortedStaff(), groups: listGroups() };
  }

  if (head === 'staff' && method === 'PATCH') {
    const person = STATE.staff.find((s) => s.staff_id === Number(rest[0]));
    if (!person) bad('人員不存在');

    if (body.name !== undefined) person.name = requireName(body.name, '姓名');
    if (body.role !== undefined) {
      if (!Object.values(ROLE).includes(body.role)) bad('身分需為師傅或徒弟');
      person.role = body.role;
    }
    if (body.is_active !== undefined) person.is_active = Boolean(body.is_active);

    await saveConfig();
    return { staff: sortedStaff(), groups: listGroups(), fairness: listFairness() };
  }

  if (head === 'staff' && method === 'DELETE') {
    const staffId = Number(rest[0]);
    if (!STATE.staff.some((s) => s.staff_id === staffId)) bad('人員不存在');

    let vacated = 0;
    for (const [week, data] of Object.entries(STATE.weeks)) {
      let touched = false;
      for (const row of data.rows) {
        if (row.staff_id === staffId) { row.staff_id = null; vacated += 1; touched = true; }
      }
      const before = data.absences.length;
      data.absences = data.absences.filter((a) => a.staff_id !== staffId);
      if (touched || data.absences.length !== before) await saveWeek(week);
    }
    STATE.staff = STATE.staff.filter((s) => s.staff_id !== staffId);
    delete STATE.fairness[staffId];
    await saveConfig();
    return { staff: sortedStaff(), groups: listGroups(), vacated_slots: vacated };
  }

  bad(`找不到這個操作：${path}`);
  return null;
}
