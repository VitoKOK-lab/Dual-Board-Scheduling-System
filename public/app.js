/* ============================================================
   雙板動態排班系統 — 手機端單頁應用
   資料一律由後端 API 供給；前端只負責呈現與互動，不做排班計算。
   ============================================================ */

const RING_R = 32;
const RING_C = 2 * Math.PI * RING_R;
const DAY_NAMES = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五' };
const WHITEBOARD_SHIFTS = ['MORNING', 'FLAG', 'NOON'];
const SHIFT_LABEL = { MORNING: '早修', FLAG: '升旗', NOON: '午休' };
const SHIFT_COLOR = { MORNING: 'var(--emerald)', FLAG: 'var(--topaz)', NOON: 'var(--amethyst)' };
/** 公平性維度 → 欄位、標籤、顏色、長條樣式 */
const DIMENSIONS = [
  { key: 'blackboard_count', label: '黑板', color: 'var(--sapphire)', bar: 'bar--bb' },
  { key: 'morning_whiteboard_count', label: '早修', color: 'var(--emerald)', bar: 'bar--am' },
  { key: 'flag_whiteboard_count', label: '升旗', color: 'var(--topaz)', bar: 'bar--fl' },
  { key: 'noon_whiteboard_count', label: '午休', color: 'var(--amethyst)', bar: 'bar--pm' },
];
const DRAG_THRESHOLD = 8;
const LONG_PRESS_MS = 180;

const state = {
  week: null,
  data: null,
  tab: 'blackboard',
  day: 1,
  shift: 'MORNING',
  itemsById: new Map(),
  staffById: new Map(),
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const icon = (id, cls = 'icon') => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
};
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const shortDate = (iso) => `${Number(iso.slice(5, 7))}/${iso.slice(8, 10)}`;

/* ---------- API ---------- */

let pending = 0;
function setBusy(on) {
  pending += on ? 1 : -1;
  $('#loading').hidden = pending <= 0;
}

async function api(path, { method = 'GET', body } = {}) {
  setBusy(true);
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error ?? `請求失敗（${res.status}）`);
    return payload;
  } finally {
    setBusy(false);
  }
}

let toastTimer;
function toast(message, tone = 'info') {
  const node = $('#toast');
  node.textContent = message;
  node.dataset.tone = tone;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3600);
}

/* ---------- 資料載入 ---------- */

function absorb(payload) {
  if (!payload?.schedule) return;
  state.data = payload;
  state.week = payload.schedule.week_start_date;
  state.itemsById = new Map(payload.items.map((i) => [i.item_id, i]));
  state.staffById = new Map(payload.staff.map((s) => [s.staff_id, s]));
  render();
}

async function loadWeek(week) {
  absorb(await api(`/api/week?week=${encodeURIComponent(week ?? state.week ?? todayIso())}`));
}

/* ---------- 查詢輔助 ---------- */

const itemsOf = (board, shift) => state.data.items
  .filter((i) => i.board_type === board && i.shift_type === shift)
  .sort((a, b) => a.sort_order - b.sort_order || a.item_id - b.item_id);

const slotsOf = (itemId, day) => state.data.assignments
  .filter((r) => r.item_id === itemId && (r.day_of_week ?? null) === (day ?? null))
  .sort((a, b) => a.slot_index - b.slot_index);

const staffName = (id) => state.staffById.get(id)?.name ?? '未指派';

const absencesOn = (day) => state.data.absences.filter((a) => a.day_of_week === day);

const isAbsent = (staffId, day) => state.data.absences
  .some((a) => a.staff_id === staffId && a.day_of_week === day);

/* ---------- 名牌 chip ---------- */

function tagEl(row, boardKind, day) {
  const node = el('button', 'tag');
  node.type = 'button';
  node.dataset.detailId = String(row.detail_id);
  node.dataset.board = boardKind;

  if (row.staff_id == null) {
    node.classList.add('tag--empty');
    node.append(icon('i-plus'), el('span', null, '補位'));
    node.setAttribute('aria-label', '空缺名額，點選以指派師傅');
    return node;
  }

  const name = staffName(row.staff_id);
  node.append(el('span', null, name));
  if (row.is_override) node.classList.add('tag--override');
  if (day && isAbsent(row.staff_id, day)) {
    node.classList.add('tag--absent');
    node.title = '該員當日有公差／請假';
  }
  const group = state.staffById.get(row.staff_id)?.staff_group;
  node.setAttribute('aria-label', `${name}${group ? `（${group}）` : ''}，點選以換人`);
  return node;
}

/* ---------- 星期條 ---------- */

function renderDayStrip() {
  const strip = $('#dayStrip');
  strip.replaceChildren();
  const today = todayIso();

  for (const day of [1, 2, 3, 4, 5]) {
    const date = state.data.schedule.dates[day];
    const chip = el('button', 'daychip');
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(day === state.day));
    if (date === today) chip.dataset.today = '1';
    chip.append(el('span', 'daychip__d', `週${DAY_NAMES[day]}`));
    chip.append(el('span', 'daychip__n mono', shortDate(date)));
    chip.setAttribute('aria-label', `週${DAY_NAMES[day]} ${date}`);
    chip.addEventListener('click', () => { state.day = day; render(); });
    strip.append(chip);
  }
  // 只有白板需要選日；黑板已是整週表格，公差與統計跟單日無關
  strip.hidden = state.tab !== 'whiteboard';
}


/* ---------- 表格 ---------- */

function table(className = '') {
  const wrap = el('div', 'tablewrap');
  const node = el('table', `sched ${className}`.trim());
  wrap.append(node);
  return { wrap, table: node };
}

function captionRow(title, meta) {
  const head = el('div', 'sched-caption');
  head.append(el('h2', null, title));
  if (meta) head.append(el('span', null, meta));
  return head;
}

/** 一格名牌；沒有名額時顯示灰底破折號。 */
function slotCell(slots, index, boardKind, day) {
  const cell = el('td');
  const slot = slots[index];
  if (!slot) { cell.append(el('span', 'cell-text', '—')); return cell; }
  cell.append(tagEl(slot, boardKind, day));
  return cell;
}

/* ---------- 視圖：黑板 ---------- */

function renderBlackboard() {
  const view = $('#view-blackboard');
  view.replaceChildren();

  if (!state.data.schedule.has_items) { view.append(emptyState()); return; }
  view.classList.add('stagger');

  const gaps = state.data.warnings.filter((w) => {
    const item = state.itemsById.get(w.item_id);
    return item && item.board_type === 'BLACKBOARD';
  });
  if (gaps.length) view.append(noticeEl(`黑板還有 ${gaps.length} 個名額待補`, 'ruby'));

  // 每日輪替職務：一列一個任務，五欄對應週一到週五
  const daily = itemsOf('BLACKBOARD', 'DAILY');
  if (daily.length) {
    view.append(captionRow('每日輪替職務', `${daily.length} 項 × 5 天`));

    const { wrap, table: node } = table('sched--week');
    const thead = el('thead');
    const headRow = el('tr');
    headRow.append(el('th', null, ''));
    for (const day of [1, 2, 3, 4, 5]) {
      const th = el('th', null, `週${DAY_NAMES[day]}`);
      th.scope = 'col';
      if (state.data.schedule.dates[day] === todayIso()) th.style.color = 'var(--ink)';
      headRow.append(th);
    }
    thead.append(headRow);
    node.append(thead);

    const tbody = el('tbody');
    for (const item of daily) {
      const row = el('tr');
      const label = el('th', null, item.item_name);
      label.scope = 'row';
      row.append(label);
      for (const day of [1, 2, 3, 4, 5]) {
        row.append(slotCell(slotsOf(item.item_id, day), 0, 'BLACKBOARD', day));
      }
      tbody.append(row);
    }
    node.append(tbody);
    view.append(wrap);
  }

  // 全週固定職務：整週一人，跟日期無關
  const weekly = itemsOf('BLACKBOARD', 'ALL_WEEK');
  if (weekly.length) {
    view.append(captionRow('全週固定職務', '1 週 1 次'));

    const { wrap, table: node } = table('sched--pair');
    const tbody = el('tbody');
    for (const item of weekly) {
      const row = el('tr');
      const label = el('th', null, item.item_name);
      label.scope = 'row';
      row.append(label, slotCell(slotsOf(item.item_id, null), 0, 'BLACKBOARD', null));
      tbody.append(row);
    }
    node.append(tbody);
    view.append(wrap);
  }

  const away = state.data.absences;
  if (away.length) {
    view.append(noticeEl(`本週公差／請假：${away.map((a) => `${a.name}（週${DAY_NAMES[a.day_of_week] ?? '—'}）`).join('、')}`, 'topaz'));
  }
}

/* ---------- 視圖：白板 ---------- */

function renderWhiteboard() {
  const view = $('#view-whiteboard');
  view.replaceChildren();

  if (!state.data.schedule.has_items) { view.append(emptyState()); return; }
  view.classList.add('stagger');

  const seg = el('div', 'segmented');
  seg.setAttribute('role', 'tablist');
  for (const shift of WHITEBOARD_SHIFTS) {
    const b = el('button', null, SHIFT_LABEL[shift]);
    b.type = 'button';
    b.dataset.shift = shift;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(state.shift === shift));
    b.addEventListener('click', () => { state.shift = shift; render(); });
    seg.append(b);
  }
  view.append(seg);

  const items = itemsOf('WHITEBOARD', state.shift);
  const daySlots = items.flatMap((i) => slotsOf(i.item_id, state.day));
  const filled = daySlots.filter((s) => s.staff_id != null).length;
  const total = items.reduce((sum, i) => sum + i.required_capacity, 0);

  view.append(captionRow(`${SHIFT_LABEL[state.shift]} · 週${DAY_NAMES[state.day]}`, `${filled}/${total} 名額`));

  const { wrap, table: node } = table();
  const thead = el('thead');
  const headRow = el('tr');
  for (const label of ['點位', '人員']) {
    const th = el('th', null, label);
    th.scope = 'col';
    headRow.append(th);
  }
  thead.append(headRow);
  node.append(thead);

  const tbody = el('tbody');
  let currentZone = null;

  for (const item of items) {
    // 升旗底下分定點與巡查，用整列標題隔開
    const zone = item.zone || '';
    if (zone && zone !== currentZone) {
      const zoneRow = el('tr', 'zone-row');
      const th = el('th', null, zone);
      th.colSpan = 2;
      th.scope = 'colgroup';
      zoneRow.append(th);
      tbody.append(zoneRow);
      currentZone = zone;
    }

    const slots = slotsOf(item.item_id, state.day);
    // 一個點位排多人時，每人各佔一列，點位名用 rowspan 合併
    for (let i = 0; i < Math.max(1, slots.length); i += 1) {
      const row = el('tr');
      if (i === 0) {
        const label = el('th', null, item.item_name);
        label.scope = 'row';
        if (slots.length > 1) label.rowSpan = slots.length;
        row.append(label);
      }
      row.append(slotCell(slots, i, state.shift, state.day));
      tbody.append(row);
    }
  }

  node.append(tbody);
  view.append(wrap);
}

/* ---------- 視圖：公差 ---------- */

function renderAbsence() {
  const view = $('#view-absence');
  view.replaceChildren();
  view.classList.add('stagger');

  // 公差／請假
  view.append(captionRow('公差／請假', `${state.data.absences.length} 筆`));

  if (state.data.absences.length === 0) {
    const empty = el('div', 'card');
    empty.append(el('p', 'field__hint', '本週尚無登錄紀錄。公差僅作行程提示，不計入公平性統計；排班時會自動避開登錄者當天。'));
    view.append(empty);
  } else {
    const { wrap, table: node } = table();
    const thead = el('thead');
    const headRow = el('tr');
    for (const label of ['人員', '日期', '類型', '']) {
      const th = el('th', null, label);
      th.scope = 'col';
      headRow.append(th);
    }
    thead.append(headRow);
    node.append(thead);

    const tbody = el('tbody');
    for (const a of state.data.absences) {
      const row = el('tr');

      const who = el('th', null, '');
      who.scope = 'row';
      who.append(document.createTextNode(a.name));
      if (a.note) who.append(el('span', 'cell-sub', a.note));
      row.append(who);

      row.append(el('td', 'cell-text', `${shortDate(a.absence_date)}（${DAY_NAMES[a.day_of_week] ?? '—'}）`));
      row.append(el('td', 'cell-text', a.absence_type === 'OFFICIAL' ? '公差' : '請假'));

      const action = el('td', 'cell-action');
      const del = el('button', 'iconbtn');
      del.type = 'button';
      del.setAttribute('aria-label', `刪除 ${a.name} 的紀錄`);
      del.append(icon('i-trash'));
      del.addEventListener('click', async () => {
        absorb(await api(`/api/absences/${a.absence_id}?week=${state.week}`, { method: 'DELETE' }));
        toast('已刪除紀錄');
      });
      action.append(del);
      row.append(action);

      tbody.append(row);
    }
    node.append(tbody);
    view.append(wrap);
  }

  const addBtn = el('button', 'btn btn--block btn--primary');
  addBtn.type = 'button';
  addBtn.append(icon('i-calendar'), el('span', null, '登錄公差／請假'));
  addBtn.addEventListener('click', openAbsenceSheet);
  view.append(addBtn);

  // 待補名額
  const gaps = state.data.warnings;
  view.append(captionRow('待補名額', `${gaps.length} 個`));

  if (gaps.length === 0) {
    const done = el('div', 'card');
    done.append(el('p', 'field__hint', '所有名額都已排滿。'));
    view.append(done);
    return;
  }

  const { wrap, table: node } = table();
  const thead = el('thead');
  const headRow = el('tr');
  for (const label of ['點位', '時段', '']) {
    const th = el('th', null, label);
    th.scope = 'col';
    headRow.append(th);
  }
  thead.append(headRow);
  node.append(thead);

  const tbody = el('tbody');
  for (const g of gaps.slice(0, 40)) {
    const item = state.itemsById.get(g.item_id);
    const shiftName = item && item.board_type === 'WHITEBOARD' ? SHIFT_LABEL[item.shift_type] : '黑板';

    const row = el('tr');
    const label = el('th', null, g.item_name ?? '未知點位');
    label.scope = 'row';
    row.append(label);
    row.append(el('td', 'cell-text', `${shiftName}・${g.day_of_week ? `週${DAY_NAMES[g.day_of_week]}` : '全週'}`));

    const action = el('td', 'cell-action');
    const fill = el('button', 'iconbtn');
    fill.type = 'button';
    fill.setAttribute('aria-label', `補 ${g.item_name} 的空缺`);
    fill.append(icon('i-plus'));
    fill.addEventListener('click', () => openPlanX(g.detail_id));
    action.append(fill);
    row.append(action);

    tbody.append(row);
  }
  node.append(tbody);
  view.append(wrap);
}

/* ---------- 視圖：統計 ---------- */

/**
 * 輪替均衡度：整數分配下，人人次數相差不超過 1 次即為完全公平（100%）。
 * 差距每多出 1 次，就相對於「最差可能差距」等比扣分。
 */
function balance(rows, key) {
  if (rows.length === 0) return { pct: 100, min: 0, max: 0 };

  const counts = rows.map((r) => r[key]);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const spread = max - min;

  if (spread <= 1) return { pct: 100, min, max };
  const worst = Math.max(1, max - 1);
  return { pct: Math.max(0, Math.round((1 - (spread - 1) / worst) * 100)), min, max };
}

function ringEl(label, stat, color) {
  const wrap = el('div', 'ring');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 76 76');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${label} ${stat.pct}%，範圍 ${stat.min} 至 ${stat.max} 次`);
  for (const cls of ['ring__track', 'ring__bar']) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '38'); c.setAttribute('cy', '38'); c.setAttribute('r', String(RING_R));
    if (cls === 'ring__bar') {
      c.setAttribute('stroke', color);
      c.setAttribute('stroke-dasharray', String(RING_C));
      c.setAttribute('stroke-dashoffset', String(RING_C * (1 - Math.min(100, stat.pct) / 100)));
    }
    svg.append(c);
  }
  wrap.append(svg);
  wrap.append(el('span', 'ring__val mono', `${stat.pct}%`));
  wrap.append(el('span', 'ring__label', label));
  wrap.append(el('span', 'ring__range mono', `${stat.min}–${stat.max}`));
  return wrap;
}

function renderStats() {
  const view = $('#view-stats');
  view.replaceChildren();
  view.classList.add('stagger');

  const masters = state.data.fairness.filter((f) => f.role === 'MASTER');
  const apprentices = state.data.fairness.filter((f) => f.role !== 'MASTER');
  const activeMasters = masters.filter((f) => f.is_active);

  // 供需：每人每個時段只能站一個點位，尖峰名額數就是師傅數的下限
  const cap = state.data.capacity;
  if (cap) {
    const supply = el('div', 'card');
    const head = el('div', 'card__title');
    head.append(el('h3', null, '人力供需'), badge(cap.feasible ? '可排滿' : '人力不足', cap.feasible ? 'emerald' : 'ruby'));
    supply.append(head);

    const list = el('div', 'rowlist');
    const line = (title, value, sub) => {
      const row = el('div', 'rowitem');
      const main = el('div', 'rowitem__main');
      main.append(el('div', 'rowitem__title', title));
      if (sub) main.append(el('div', 'rowitem__sub', sub));
      row.append(main, el('span', 'person__total mono', String(value)));
      return row;
    };

    list.append(line('可排班師傅', cap.masters, `徒弟 ${apprentices.length} 位不列入`));
    for (const sh of cap.shifts ?? []) {
      list.append(line(`${sh.label}名額`, sh.slots, `${sh.points} 個點位`));
    }
    list.append(line('尖峰時段用量', `${cap.peak_slots}/${cap.masters}`, '單一時段每人只能站一個點位'));
    supply.append(list);

    if (!cap.feasible) {
      supply.append(noticeEl(`尖峰時段需要 ${cap.peak_slots} 人，但只有 ${cap.masters} 位師傅，每個時段必然留下 ${cap.peak_slots - cap.masters} 個空缺。請減少點位、降低每點人數，或升級更多徒弟。`, 'ruby'));
    }
    view.append(supply);
  }

  if (activeMasters.length > 0) {
    const card = el('div', 'card');
    const head = el('div', 'card__title');
    head.append(el('h3', null, '師傅輪替均衡度'), badge(`${activeMasters.length} 位`, 'emerald'));
    card.append(head);

    const rings = el('div', 'rings rings--wide');
    for (const d of DIMENSIONS) {
      rings.append(ringEl(d.label, balance(activeMasters, d.key), d.color));
    }
    card.append(rings);
    card.append(el('p', 'field__hint', '人人次數相差不超過 1 次即為 100%；環下數字為實際的最少與最多次數。'));
    view.append(card);
  }

  const idle = activeMasters.filter((f) => DIMENSIONS.every((d) => f[d.key] === 0));
  if (idle.length > 0 && (state.data.published_weeks ?? 0) > 0) {
    view.append(noticeEl(`累計仍為零任務：${idle.map((f) => f.name).join('、')}`, 'ruby'));
  }

  const legend = el('div', 'legend');
  for (const d of DIMENSIONS) {
    const item = el('span');
    const swatch = el('i');
    swatch.style.background = d.color;
    item.append(swatch, document.createTextNode(d.label));
    legend.append(item);
  }
  view.append(legend);

  view.append(rosterSection('師傅', masters, true));
  view.append(rosterSection('徒弟', apprentices, false));
}

/** 名冊區塊：師傅顯示負擔長條，徒弟顯示學級與升級入口。 */
function rosterSection(title, rows, withLoad) {
  const wrap = document.createDocumentFragment();

  const head = el('div', 'section-head');
  head.append(el('h2', null, withLoad ? `${title}（可排班）` : `${title}（不排班）`));
  head.append(el('span', 'section-head__meta', `${rows.length} 位`));
  wrap.append(head);

  if (rows.length === 0) {
    const empty = el('div', 'card');
    empty.append(el('p', 'field__hint', '目前沒有人。'));
    wrap.append(empty);
    return wrap;
  }

  const sorted = withLoad
    ? [...rows].sort((a, b) => {
      const ta = DIMENSIONS.reduce((sum, d) => sum + a[d.key], 0);
      const tb = DIMENSIONS.reduce((sum, d) => sum + b[d.key], 0);
      return tb - ta || a.staff_id - b.staff_id;
    })
    : rows;

  const card = el('div', 'card card--flush');
  const peak = Math.max(1, ...sorted.flatMap((r) => DIMENSIONS.map((d) => r[d.key])));

  for (const r of sorted) {
    const total = DIMENSIONS.reduce((sum, d) => sum + r[d.key], 0);
    const btn = el('button', `person${r.is_active ? '' : ' person--off'}`);
    btn.type = 'button';

    const nameWrap = el('div', 'person__name');
    nameWrap.append(document.createTextNode(r.name));
    if (withLoad) {
      const sub = `${r.staff_group}・${DIMENSIONS.map((d) => `${d.label} ${r[d.key]}`).join('・')}`;
      nameWrap.append(el('span', null, sub));
    } else {
      nameWrap.append(el('span', null, `${r.staff_group}・點選可升級為師傅`));
    }
    btn.append(nameWrap);

    if (withLoad) {
      const bars = el('div', 'person__bars');
      for (const d of DIMENSIONS) {
        const val = r[d.key];
        const bar = el('i', `bar ${val === 0 ? 'bar--zero' : d.bar}`);
        bar.style.height = `${Math.max(3, Math.round((val / peak) * 28))}px`;
        bars.append(bar);
      }
      btn.append(bars);
      btn.append(el('span', 'person__total mono', String(total)));
    } else {
      btn.append(badge('升級', 'topaz'));
    }

    btn.addEventListener('click', () => openStaffSheet(r));
    card.append(btn);
  }

  wrap.append(card);
  return wrap;
}

/* ---------- 共用片段 ---------- */

function badge(text, tone) {
  return el('span', `badge badge--${tone}`, text);
}

function noticeEl(text, tone) {
  const n = el('div', `notice${tone === 'topaz' ? ' notice--topaz' : ''}`);
  n.append(icon('i-alert'), el('span', null, text));
  return n;
}

function emptyState() {
  const wrap = el('div', 'empty');
  wrap.append(icon('i-bolt'));
  wrap.append(el('h3', null, '本週尚未排班'));
  wrap.append(el('p', null, '按下方中央的按鈕，系統會依歷史次數由少到多自動填滿黑板與白板，每位師傅都會排到任務。'));
  return wrap;
}

/* ---------- Bottom sheet ---------- */

let sheetOnClose = null;

function openSheet(title, subtitle, buildBody, onClose = null) {
  $('#sheetTitle').textContent = title;
  $('#sheetSub').textContent = subtitle ?? '';
  const body = $('#sheetBody');
  body.replaceChildren();
  buildBody(body);
  $('#scrim').hidden = false;
  $('#sheet').hidden = false;
  sheetOnClose = onClose;
  $('#sheetClose').focus();
}

function closeSheet() {
  $('#scrim').hidden = true;
  $('#sheet').hidden = true;
  const cb = sheetOnClose;
  sheetOnClose = null;
  if (cb) cb();
}

function confirmSheet({ title, message, confirmLabel, tone = 'primary' }) {
  return new Promise((resolve) => {
    let done = false;
    openSheet(title, null, (body) => {
      body.append(el('p', 'field__hint', message));
      const ok = el('button', `btn btn--block ${tone === 'danger' ? 'btn--danger' : 'btn--primary'}`, confirmLabel);
      ok.type = 'button';
      ok.addEventListener('click', () => { done = true; closeSheet(); resolve(true); });
      const cancel = el('button', 'btn btn--block btn--quiet', '取消');
      cancel.type = 'button';
      cancel.addEventListener('click', () => closeSheet());
      body.append(ok, cancel);
    }, () => { if (!done) resolve(false); });
  });
}

/* ---------- Plan X 換人 ---------- */

async function openPlanX(detailId) {
  const info = await api(`/api/assignments/${detailId}/plan-x`);
  const shiftLabel = info.item.board_type === 'BLACKBOARD'
    ? '黑板'
    : (SHIFT_LABEL[info.item.shift_type] ?? info.item.shift_type);
  const dayLabel = info.day_of_week ? `週${DAY_NAMES[info.day_of_week]}` : '全週';
  const current = info.current_staff_id ? staffName(info.current_staff_id) : '空缺';

  openSheet(`${info.item.item_name}`, `${shiftLabel} · ${dayLabel} · 目前：${current}`, (body) => {
    body.append(el('p', 'field__hint', '只有師傅能排班，因此名單僅列出師傅，並依目前負擔由輕到重排序。主管可強制指派，衝突僅提示不阻擋。'));

    for (const c of info.candidates) {
      body.append(candidateRow(detailId, c, shiftLabel));
    }

    const search = el('div', 'field');
    const label = el('label', null, '指派其他師傅');
    label.setAttribute('for', 'staffPick');
    const select = el('select');
    select.id = 'staffPick';
    select.append(new Option('— 選擇人員 —', ''));
    const pickable = state.data.staff.filter((person) => person.is_active && person.role === 'MASTER');
    for (const person of pickable) {
      select.append(new Option(`${person.name}（${person.staff_group}）`, String(person.staff_id)));
    }
    select.addEventListener('change', async () => {
      if (!select.value) return;
      await assign(detailId, Number(select.value));
    });
    search.append(label, select);
    body.append(search);

    if (info.current_staff_id != null) {
      const clear = el('button', 'btn btn--block btn--danger');
      clear.type = 'button';
      clear.append(icon('i-trash'), el('span', null, '清空此名額'));
      clear.addEventListener('click', () => assign(detailId, null));
      body.append(clear);
    }
  });
}

function candidateRow(detailId, c, shiftLabel) {
  const btn = el('button', 'cand');
  btn.type = 'button';

  const main = el('div', 'cand__main');
  main.append(el('div', 'cand__name', c.name));

  // 只在會踩到限制時才加標籤
  if (c.conflicts.length) {
    const why = el('div', 'cand__why');
    for (const conflict of c.conflicts) why.append(badge(conflict.label, 'ruby'));
    main.append(why);
  }

  const stat = el('div', 'cand__num mono');
  stat.textContent = `${c.staff_group} · 歷史${shiftLabel} ${c.historyCount} 次 · 本週已排 ${c.weekAssigned}`;
  main.append(stat);

  btn.append(main);
  btn.append(icon('i-check'));
  btn.addEventListener('click', () => assign(detailId, c.staff_id));
  return btn;
}

async function assign(detailId, staffId) {
  const result = await api(`/api/assignments/${detailId}`, { method: 'PATCH', body: { staff_id: staffId } });
  absorb(result);
  closeSheet();
  if (result.conflicts?.length) {
    toast(`已強制指派，注意：${result.conflicts.map((c) => c.label).join('、')}`, 'error');
  } else {
    toast(staffId == null ? '已清空名額' : '已更新名額');
  }
}

/* ---------- 公差登錄 ---------- */

function openAbsenceSheet() {
  openSheet('登錄公差／請假', '只列出師傅；登錄後重新排班會自動避開當天', (body) => {
    const staffField = el('div', 'field');
    const staffLabel = el('label', null, '人員');
    staffLabel.setAttribute('for', 'absStaff');
    const staffSelect = el('select');
    staffSelect.id = 'absStaff';
    // 徒弟不排班，登錄他們的公差沒有意義
    for (const person of state.data.staff.filter((p) => p.is_active && p.role === 'MASTER')) {
      staffSelect.append(new Option(person.name, String(person.staff_id)));
    }
    staffField.append(staffLabel, staffSelect);

    const dateField = el('div', 'field');
    const dateLabel = el('label', null, '日期');
    dateLabel.setAttribute('for', 'absDate');
    const dateInput = el('input');
    dateInput.type = 'date';
    dateInput.id = 'absDate';
    dateInput.min = state.data.schedule.week_start_date;
    dateInput.max = state.data.schedule.week_end_date;
    dateInput.value = state.data.schedule.dates[state.day];
    dateField.append(dateLabel, dateInput, el('span', 'field__hint', '限本週週一至週五'));

    const typeField = el('div', 'field');
    const typeLabel = el('label', null, '類型');
    typeLabel.setAttribute('for', 'absType');
    const typeSelect = el('select');
    typeSelect.id = 'absType';
    typeSelect.append(new Option('公差', 'OFFICIAL'), new Option('請假', 'LEAVE'));
    typeField.append(typeLabel, typeSelect);

    const noteField = el('div', 'field');
    const noteLabel = el('label', null, '備註');
    noteLabel.setAttribute('for', 'absNote');
    const noteInput = el('input');
    noteInput.type = 'text';
    noteInput.id = 'absNote';
    noteInput.placeholder = '例：校外研習';
    noteField.append(noteLabel, noteInput);

    const error = el('p', 'field__error');
    error.hidden = true;
    error.setAttribute('role', 'alert');

    const submit = el('button', 'btn btn--block btn--primary');
    submit.type = 'button';
    submit.append(icon('i-check'), el('span', null, '登錄'));
    submit.addEventListener('click', async () => {
      if (!dateInput.value || dateInput.value < dateInput.min || dateInput.value > dateInput.max) {
        error.textContent = '日期需落在本週週一至週五，請重新選擇。';
        error.hidden = false;
        dateInput.focus();
        return;
      }
      absorb(await api('/api/absences', {
        method: 'POST',
        body: {
          staff_id: Number(staffSelect.value),
          absence_date: dateInput.value,
          absence_type: typeSelect.value,
          note: noteInput.value.trim() || null,
        },
      }));
      closeSheet();
      toast('已登錄，重新排班時會自動避開');
    });

    body.append(staffField, dateField, typeField, noteField, error, submit);
  });
}

/* ---------- 人員細節 ---------- */

function openStaffSheet(person) {
  const isMaster = person.role === 'MASTER';
  const total = DIMENSIONS.reduce((sum, d) => sum + person[d.key], 0);
  const subtitle = isMaster
    ? `${person.staff_group} · 師傅 · 累計 ${total} 次任務`
    : `${person.staff_group} · 徒弟 · 不排班`;

  openSheet(person.name, subtitle, (body) => {
    if (isMaster) {
      // 環代表相對於師傅平均的比例，滿環 = 達到平均
      const peers = state.data.fairness.filter((f) => f.role === 'MASTER' && f.is_active);
      const avg = (key) => (peers.length ? peers.reduce((sum, f) => sum + f[key], 0) / peers.length : 0);
      const share = (value, key) => {
        const mean = avg(key);
        return { pct: mean > 0 ? Math.min(150, Math.round((value / mean) * 100)) : 100, min: value, max: Math.round(mean) };
      };

      const rings = el('div', 'rings rings--wide');
      for (const d of DIMENSIONS) rings.append(ringEl(d.label, share(person[d.key], d.key), d.color));
      body.append(rings);
      body.append(el('p', 'field__hint', '環代表相對於師傅平均的比例，環下為「本人次數／師傅平均」。'));
    } else {
      body.append(el('p', 'field__hint', '徒弟跟著師傅學習，不進入排班池、不計入點位人數。升級為師傅後才會被排到班。'));
    }

    const promote = el('button', `btn btn--block ${isMaster ? 'btn--quiet' : 'btn--primary'}`);
    promote.type = 'button';
    promote.textContent = isMaster ? '降回徒弟' : '升級為師傅';
    promote.addEventListener('click', async () => {
      await api(`/api/staff/${person.staff_id}`, {
        method: 'PATCH',
        body: { role: isMaster ? 'APPRENTICE' : 'MASTER' },
      });
      await loadWeek(state.week);
      closeSheet();
      toast(isMaster ? `${person.name} 已降回徒弟，下次排班不再指派` : `${person.name} 已升級為師傅，下次排班起納入`);
    });
    body.append(promote);

    const toggle = el('button', `btn btn--block ${person.is_active ? 'btn--danger' : 'btn--quiet'}`);
    toggle.type = 'button';
    toggle.textContent = person.is_active ? '停用此人員' : '恢復啟用';
    toggle.addEventListener('click', async () => {
      await api(`/api/staff/${person.staff_id}`, { method: 'PATCH', body: { is_active: !person.is_active } });
      await loadWeek(state.week);
      closeSheet();
      toast(person.is_active ? '已停用，後續排班不再指派' : '已恢復啟用');
    });
    body.append(toggle);
  });
}


/* ---------- 設定：點位與成員管理 ---------- */

const BOARD_SECTIONS = [
  { board: 'WHITEBOARD', shift: 'MORNING', label: '白板・早修' },
  { board: 'WHITEBOARD', shift: 'FLAG', label: '白板・升旗' },
  { board: 'WHITEBOARD', shift: 'NOON', label: '白板・午休' },
  { board: 'BLACKBOARD', shift: 'ALL_WEEK', label: '黑板・全週職務' },
  { board: 'BLACKBOARD', shift: 'DAILY', label: '黑板・每日職務' },
];

let adminTab = 'items';

function openSettings() {
  openSheet('設定', '調整點位與成員後，回到看板按閃電鈕重新排班', renderSettings);
}

function renderSettings(body) {
  body.replaceChildren();

  const seg = el('div', 'segmented');
  seg.setAttribute('role', 'tablist');
  for (const [key, label, iconId] of [['items', '點位', 'i-pin'], ['staff', '成員', 'i-users'], ['backup', '備份', 'i-save']]) {
    const b = el('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(adminTab === key));
    b.append(icon(iconId), document.createTextNode(label));
    b.style.display = 'inline-flex';
    b.style.alignItems = 'center';
    b.style.justifyContent = 'center';
    b.style.gap = '6px';
    b.addEventListener('click', () => { adminTab = key; renderSettings(body); });
    seg.append(b);
  }
  body.append(seg);

  if (adminTab === 'items') renderItemAdmin(body);
  else if (adminTab === 'staff') renderStaffAdmin(body);
  else renderBackupAdmin(body);
}

/**
 * 把檔案交給使用者。Artifact 沙箱擋掉頁面自己觸發的下載，
 * 所以有 downloads 能力時走它，一般網頁才用 <a download>。
 */
async function offerDownload(filename, text) {
  try {
    const downloads = window.claude?.use ? await window.claude.use('downloads') : null;
    if (downloads) { await downloads.save({ filename, data: text }); return; }
  } catch { /* 沒授權就退回一般下載 */ }

  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = el('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderBackupAdmin(body) {
  const card = el('div', 'card admin-form');
  card.append(el('h3', null, '匯出備份'));
  card.append(el('p', 'field__hint', '把點位、成員、累計次數與所有週的班表存成一個檔案。建議每次發布班表後存一份。'));

  const exportBtn = el('button', 'btn btn--block btn--primary');
  exportBtn.type = 'button';
  exportBtn.append(icon('i-save'), el('span', null, '匯出成檔案'));
  exportBtn.addEventListener('click', async () => {
    const dump = await api('/api/backup');
    const stamp = todayIso().replaceAll('-', '');
    // 檔名用 ASCII：Chromium 在 blob 下載時會把含中文的檔名整個丟掉，
    // 而且手機的檔案管理與郵件附件對非 ASCII 檔名也常出包
    await offerDownload(`dual-board-backup-${stamp}.json`, JSON.stringify(dump, null, 2));
    toast('已匯出備份');
  });
  card.append(exportBtn);
  body.append(card);

  const restore = el('div', 'card admin-form');
  restore.append(el('h3', null, '從備份還原'));
  restore.append(el('p', 'field__hint', '還原會整份取代現在的資料，包含點位、成員與所有班表。這個動作無法復原。'));

  const error = el('p', 'field__error');
  error.hidden = true;
  error.setAttribute('role', 'alert');

  const picker = el('input');
  picker.type = 'file';
  picker.id = 'backupFile';
  picker.accept = 'application/json,.json';
  picker.hidden = true;
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    if (!file) return;
    error.hidden = true;

    try {
      const parsed = JSON.parse(await file.text());
      const result = await api('/api/backup', { method: 'POST', body: parsed });
      await loadWeek(todayIso());
      renderSettings($('#sheetBody'));
      const n = result.imported;
      toast(`已還原：${n.items} 個點位、${n.staff} 位成員、${n.weeks} 週班表`);
    } catch (e) {
      error.textContent = e instanceof SyntaxError ? '這個檔案不是合法的 JSON。' : e.message;
      error.hidden = false;
    } finally {
      picker.value = '';
    }
  });

  const pick = el('button', 'btn btn--block btn--danger');
  pick.type = 'button';
  pick.append(icon('i-undo'), el('span', null, '選擇備份檔還原'));
  pick.addEventListener('click', () => picker.click());

  restore.append(error, pick, picker);
  body.append(restore);
}

/** 變更後重抓整週資料，讓供需與班表同步更新。 */
async function afterAdminChange(body, message) {
  await loadWeek(state.week);
  renderSettings(body);
  toast(message);
}

function renderItemAdmin(body) {
  const form = el('div', 'card admin-form');
  form.append(el('h3', null, '新增點位'));

  const grid = el('div', 'admin-form__grid');

  const sectionField = el('div', 'field');
  const sectionLabel = el('label', null, '時段');
  sectionLabel.setAttribute('for', 'newItemSection');
  const sectionSelect = el('select');
  sectionSelect.id = 'newItemSection';
  for (const [i, sec] of BOARD_SECTIONS.entries()) sectionSelect.append(new Option(sec.label, String(i)));
  sectionField.append(sectionLabel, sectionSelect);

  const zoneField = el('div', 'field');
  const zoneLabel = el('label', null, '分區');
  zoneLabel.setAttribute('for', 'newItemZone');
  const zoneSelect = el('select');
  zoneSelect.id = 'newItemZone';
  zoneSelect.append(new Option('定點', '定點'), new Option('巡查', '巡查'));
  zoneField.append(zoneLabel, zoneSelect);

  const capField = el('div', 'field');
  const capLabel = el('label', null, '人數');
  capLabel.setAttribute('for', 'newItemCap');
  const capInput = el('input');
  capInput.type = 'number';
  capInput.id = 'newItemCap';
  capInput.min = '1';
  capInput.max = '20';
  capInput.value = '2';
  capInput.inputMode = 'numeric';
  capField.append(capLabel, capInput);

  const nameField = el('div', 'field');
  const nameLabel = el('label', null, '點位名稱');
  nameLabel.setAttribute('for', 'newItemName');
  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.id = 'newItemName';
  nameInput.placeholder = '例：育英樓 1F';
  nameField.append(nameLabel, nameInput);

  const syncZone = () => {
    zoneField.hidden = BOARD_SECTIONS[Number(sectionSelect.value)].shift !== 'FLAG';
  };
  sectionSelect.addEventListener('change', syncZone);
  syncZone();

  grid.append(sectionField, capField);
  form.append(grid, nameField, zoneField);

  const error = el('p', 'field__error');
  error.hidden = true;
  error.setAttribute('role', 'alert');
  form.append(error);

  const submit = el('button', 'btn btn--block btn--primary');
  submit.type = 'button';
  submit.append(icon('i-plus'), el('span', null, '新增點位'));
  submit.addEventListener('click', async () => {
    const sec = BOARD_SECTIONS[Number(sectionSelect.value)];
    const name = nameInput.value.trim();
    if (!name) {
      error.textContent = '請輸入點位名稱。';
      error.hidden = false;
      nameInput.focus();
      return;
    }
    try {
      await api('/api/items', {
        method: 'POST',
        body: {
          board_type: sec.board,
          shift_type: sec.shift,
          item_name: name,
          required_capacity: Number(capInput.value) || 1,
          zone: sec.shift === 'FLAG' ? zoneSelect.value : '',
        },
      });
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      return;
    }
    await afterAdminChange($('#sheetBody'), `已新增「${name}」`);
  });
  form.append(submit);
  body.append(form);

  for (const sec of BOARD_SECTIONS) {
    const rows = state.data.items.filter((i) => i.board_type === sec.board && i.shift_type === sec.shift);

    const head = el('div', 'section-head');
    head.append(el('h2', null, sec.label));
    const slots = rows.reduce((sum, i) => sum + i.required_capacity, 0);
    head.append(el('span', 'section-head__meta', `${rows.length} 點 · ${slots} 名額`));
    body.append(head);

    const card = el('div', 'card card--flush');
    if (rows.length === 0) {
      card.append(el('p', 'field__hint', '尚未設定點位。'));
    } else {
      for (const item of rows) card.append(itemAdminRow(item));
    }
    body.append(card);
  }
}

function itemAdminRow(item) {
  const row = el('div', 'admin-row');

  const main = el('div', 'admin-row__main');
  main.append(editableName(item.item_name, async (next) => {
    await api(`/api/items/${item.item_id}`, { method: 'PATCH', body: { item_name: next } });
    await afterAdminChange($('#sheetBody'), `已改名為「${next}」`);
  }));
  if (item.zone) main.append(el('div', 'admin-row__sub', item.zone));
  row.append(main);

  const stepper = el('div', 'stepper');
  const minus = el('button');
  minus.type = 'button';
  minus.setAttribute('aria-label', `${item.item_name} 減少一人`);
  minus.append(icon('i-minus'));
  minus.disabled = item.required_capacity <= 1;

  const value = el('span', 'stepper__value mono', String(item.required_capacity));

  const plus = el('button');
  plus.type = 'button';
  plus.setAttribute('aria-label', `${item.item_name} 增加一人`);
  plus.append(icon('i-plus'));
  plus.disabled = item.required_capacity >= 20;

  const setCapacity = async (next) => {
    await api(`/api/items/${item.item_id}`, { method: 'PATCH', body: { required_capacity: next } });
    await afterAdminChange($('#sheetBody'), `${item.item_name} 改為 ${next} 人`);
  };
  minus.addEventListener('click', () => setCapacity(item.required_capacity - 1));
  plus.addEventListener('click', () => setCapacity(item.required_capacity + 1));
  stepper.append(minus, value, plus);
  row.append(stepper);

  row.append(deleteControl(row, `刪除點位「${item.item_name}」`, async () => {
    const res = await api(`/api/items/${item.item_id}`, { method: 'DELETE' });
    await afterAdminChange($('#sheetBody'), res.removed_assignments
      ? `已刪除「${item.item_name}」，同時移除 ${res.removed_assignments} 個班表名額`
      : `已刪除「${item.item_name}」`);
  }));

  return row;
}

function renderStaffAdmin(body) {
  const form = el('div', 'card admin-form');
  form.append(el('h3', null, '新增成員'));

  const nameField = el('div', 'field');
  const nameLabel = el('label', null, '姓名');
  nameLabel.setAttribute('for', 'newStaffName');
  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.id = 'newStaffName';
  nameInput.placeholder = '例：王小明';
  nameField.append(nameLabel, nameInput);

  const grid = el('div', 'admin-form__grid');

  const groupField = el('div', 'field');
  const groupLabel = el('label', null, '學級');
  groupLabel.setAttribute('for', 'newStaffGroup');
  const groupInput = el('input');
  groupInput.type = 'text';
  groupInput.id = 'newStaffGroup';
  groupInput.placeholder = '高一組';
  groupInput.setAttribute('list', 'groupOptions');
  const datalist = el('datalist');
  datalist.id = 'groupOptions';
  for (const g of state.data.groups ?? []) datalist.append(new Option(g.name, g.name));
  groupField.append(groupLabel, groupInput, datalist);

  const roleField = el('div', 'field');
  const roleLabel = el('label', null, '身分');
  roleLabel.setAttribute('for', 'newStaffRole');
  const roleSelect = el('select');
  roleSelect.id = 'newStaffRole';
  roleSelect.append(new Option('徒弟（不排班）', 'APPRENTICE'), new Option('師傅（可排班）', 'MASTER'));
  roleField.append(roleLabel, roleSelect);

  grid.append(groupField, roleField);
  form.append(nameField, grid);

  const error = el('p', 'field__error');
  error.hidden = true;
  error.setAttribute('role', 'alert');
  form.append(error);

  const submit = el('button', 'btn btn--block btn--primary');
  submit.type = 'button';
  submit.append(icon('i-plus'), el('span', null, '新增成員'));
  submit.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) {
      error.textContent = '請輸入姓名。';
      error.hidden = false;
      nameInput.focus();
      return;
    }
    try {
      await api('/api/staff', {
        method: 'POST',
        body: { name, staff_group: groupInput.value.trim(), role: roleSelect.value },
      });
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      return;
    }
    await afterAdminChange($('#sheetBody'), `已新增「${name}」`);
  });
  form.append(submit);
  body.append(form);

  for (const [role, label] of [['MASTER', '師傅（可排班）'], ['APPRENTICE', '徒弟（不排班）']]) {
    const rows = state.data.staff.filter((s) => s.role === role);

    const head = el('div', 'section-head');
    head.append(el('h2', null, label));
    head.append(el('span', 'section-head__meta', `${rows.length} 位`));
    body.append(head);

    const card = el('div', 'card card--flush');
    if (rows.length === 0) {
      card.append(el('p', 'field__hint', '目前沒有人。'));
    } else {
      for (const person of rows) card.append(staffAdminRow(person));
    }
    body.append(card);
  }
}

function staffAdminRow(person) {
  const row = el('div', 'admin-row');

  const main = el('div', 'admin-row__main');
  main.append(editableName(person.name, async (next) => {
    await api(`/api/staff/${person.staff_id}`, { method: 'PATCH', body: { name: next } });
    await afterAdminChange($('#sheetBody'), `已改名為「${next}」`);
  }, !person.is_active));
  main.append(el('div', 'admin-row__sub', person.is_active ? person.staff_group : `${person.staff_group}・已停用`));
  row.append(main);

  const swap = el('button', 'btn btn--sm btn--quiet');
  swap.type = 'button';
  swap.textContent = person.role === 'MASTER' ? '降為徒弟' : '升為師傅';
  swap.addEventListener('click', async () => {
    await api(`/api/staff/${person.staff_id}`, {
      method: 'PATCH',
      body: { role: person.role === 'MASTER' ? 'APPRENTICE' : 'MASTER' },
    });
    await afterAdminChange($('#sheetBody'), `${person.name} 已${person.role === 'MASTER' ? '降為徒弟' : '升為師傅'}`);
  });
  row.append(swap);

  row.append(deleteControl(row, `刪除成員「${person.name}」`, async () => {
    const res = await api(`/api/staff/${person.staff_id}`, { method: 'DELETE' });
    await afterAdminChange($('#sheetBody'), res.vacated_slots
      ? `已刪除「${person.name}」，班表上 ${res.vacated_slots} 個名額變成空缺`
      : `已刪除「${person.name}」`);
  }));

  return row;
}

/**
 * 名稱就地改名：點一下變成輸入框。
 * 照片辨識不出的點位（待確認…）需要能直接改，不該只能刪掉重建。
 */
function editableName(current, onSave, dimmed = false) {
  const button = el('button', `admin-row__name admin-row__name--edit${dimmed ? ' person--off' : ''}`);
  button.type = 'button';
  button.textContent = current;
  button.setAttribute('aria-label', `重新命名「${current}」`);

  button.addEventListener('click', () => {
    const box = el('div', 'admin-row__rename');
    const input = el('input');
    input.type = 'text';
    input.value = current;
    input.setAttribute('aria-label', '新名稱');

    const commit = async () => {
      const next = input.value.trim();
      if (!next || next === current) { box.replaceWith(button); return; }
      await onSave(next);
    };

    const ok = el('button', 'iconbtn');
    ok.type = 'button';
    ok.setAttribute('aria-label', '儲存名稱');
    ok.append(icon('i-check'));
    ok.addEventListener('click', commit);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') box.replaceWith(button);
    });

    box.append(input, ok);
    button.replaceWith(box);
    input.focus();
    input.select();
  });

  return button;
}

/**
 * 刪除按鈕：點一下就地展開「確定／取消」，不另開對話框。
 * 巢狀的 bottom sheet 在手機上很容易誤觸，就地確認更安全也更快。
 */
function deleteControl(row, ariaLabel, onConfirm) {
  const wrap = el('div');

  const trigger = el('button', 'iconbtn');
  trigger.type = 'button';
  trigger.setAttribute('aria-label', ariaLabel);
  trigger.append(icon('i-trash'));

  trigger.addEventListener('click', () => {
    const confirmBox = el('div', 'admin-row__confirm');
    confirmBox.append(el('span', null, '確定刪除？'));

    const cancel = el('button', 'btn btn--sm btn--quiet', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => confirmBox.replaceWith(trigger));

    const ok = el('button', 'btn btn--sm btn--danger', '刪除');
    ok.type = 'button';
    ok.addEventListener('click', onConfirm);

    confirmBox.append(cancel, ok);
    trigger.replaceWith(confirmBox);
    ok.focus();
  });

  wrap.append(trigger);
  return trigger;
}

/* ---------- 拖拉換人（Pointer Events） ---------- */

const drag = { active: false, armed: false, fromId: null, ghost: null, startX: 0, startY: 0, target: null };

function tagFromPoint(x, y) {
  const node = document.elementFromPoint(x, y);
  return node?.closest?.('.tag') ?? null;
}

function clearDropHint() {
  if (drag.target) drag.target.classList.remove('tag--dropzone');
  drag.target = null;
}

function endDrag() {
  drag.ghost?.remove();
  document.querySelector('.tag--dragging')?.classList.remove('tag--dragging');
  clearDropHint();
  Object.assign(drag, { active: false, armed: false, fromId: null, ghost: null, target: null });
}

document.addEventListener('pointerdown', (e) => {
  const tag = e.target.closest?.('.tag');
  if (!tag || tag.classList.contains('tag--empty')) return;
  drag.armed = true;
  drag.fromId = Number(tag.dataset.detailId);
  drag.startX = e.clientX;
  drag.startY = e.clientY;
  drag.node = tag;
});

document.addEventListener('pointermove', (e) => {
  if (!drag.armed) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;

  if (!drag.active) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.active = true;
    drag.node.classList.add('tag--dragging');
    const ghost = drag.node.cloneNode(true);
    ghost.classList.add('tag__ghost');
    ghost.classList.remove('tag--dragging');
    document.body.append(ghost);
    drag.ghost = ghost;
  }

  drag.ghost.style.left = `${e.clientX}px`;
  drag.ghost.style.top = `${e.clientY}px`;

  const over = tagFromPoint(e.clientX, e.clientY);
  if (over !== drag.target) {
    clearDropHint();
    if (over && Number(over.dataset.detailId) !== drag.fromId) {
      over.classList.add('tag--dropzone');
      drag.target = over;
    }
  }
  e.preventDefault();
}, { passive: false });

document.addEventListener('pointerup', async (e) => {
  const wasDragging = drag.active;
  const target = drag.target;
  const fromId = drag.fromId;
  endDrag();

  if (wasDragging) {
    if (target) {
      absorb(await api('/api/assignments/swap', {
        method: 'POST',
        body: { detail_id_a: fromId, detail_id_b: Number(target.dataset.detailId) },
      }));
      toast('已互換名牌');
    }
    return;
  }

  // 未拖曳＝單擊，開啟換人面板
  const tag = e.target.closest?.('.tag');
  if (!tag) return;
  openPlanX(Number(tag.dataset.detailId));
});

document.addEventListener('pointercancel', endDrag);

/* ---------- 主流程 ---------- */

function renderChrome() {
  const s = state.data.schedule;
  $('#weekRange').textContent = `${shortDate(s.week_start_date)} – ${shortDate(s.week_end_date)}`;

  const today = todayIso();
  const isThisWeek = today >= s.week_start_date && today <= s.week_end_date;
  $('#weekHint').textContent = isThisWeek ? '本週' : `${s.week_start_date.slice(0, 4)} 年`;

  const chip = $('#statusChip');
  chip.dataset.status = s.status;
  chip.textContent = s.status === 'PUBLISHED' ? '已發布' : '草稿';

  const publishBtn = $('#publishBtn');
  $('#publishLabel').textContent = s.status === 'PUBLISHED' ? '撤回' : '發布';
  publishBtn.disabled = !s.has_items;
  publishBtn.classList.toggle('btn--primary', s.status !== 'PUBLISHED');
  publishBtn.classList.toggle('btn--quiet', s.status === 'PUBLISHED');
  publishBtn.querySelector('use').setAttribute('href', s.status === 'PUBLISHED' ? '#i-undo' : '#i-send');
}

function render() {
  renderChrome();
  renderDayStrip();

  for (const view of document.querySelectorAll('.view')) {
    view.hidden = view.dataset.view !== state.tab;
  }
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.tab === state.tab;
    tab.classList.toggle('is-active', on);
    if (on) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }

  if (state.tab === 'blackboard') renderBlackboard();
  else if (state.tab === 'whiteboard') renderWhiteboard();
  else if (state.tab === 'absence') renderAbsence();
  else renderStats();
}

function bindChrome() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  $('#prevWeek').addEventListener('click', async () => {
    absorb(await api(`/api/week/navigate?week=${state.week}&delta=-1`));
  });
  $('#nextWeek').addEventListener('click', async () => {
    absorb(await api(`/api/week/navigate?week=${state.week}&delta=1`));
  });
  $('#weekLabel').addEventListener('click', () => loadWeek(todayIso()));

  $('#generateBtn').addEventListener('click', async () => {
    if (state.data?.schedule.has_items) {
      const ok = await confirmSheet({
        title: '重新自動排班',
        message: '本週已有班表，重新生成會覆蓋所有名額，包含手動調整過的部分。此操作無法復原。',
        confirmLabel: '覆蓋並重新排班',
        tone: 'danger',
      });
      if (!ok) return;
    }
    const result = await api('/api/week/generate', { method: 'POST', body: { week: state.week } });
    absorb(result);
    const warnings = result.generationWarnings ?? [];
    const gaps = warnings.filter((w) => w.code === 'UNDERSTAFFED').length;
    const idle = warnings.find((w) => w.code === 'IDLE_STAFF');

    if (gaps) toast(`排班完成，${gaps} 個名額人力不足`, 'error');
    else if (idle) toast(`排班完成，但 ${idle.names.join('、')} 整週沒有任務`, 'error');
    else toast('排班完成，每位師傅都有任務');
  });

  $('#publishBtn').addEventListener('click', async () => {
    const s = state.data.schedule;
    if (s.status === 'PUBLISHED') {
      const ok = await confirmSheet({
        title: '撤回發布',
        message: '撤回後本週班表回到草稿狀態，本次已累加的公平性次數會一併沖銷。',
        confirmLabel: '撤回發布',
        tone: 'danger',
      });
      if (!ok) return;
      absorb(await api(`/api/schedules/${s.schedule_id}/unpublish`, { method: 'POST' }));
      toast('已撤回，統計已沖銷');
    } else {
      absorb(await api(`/api/schedules/${s.schedule_id}/publish`, { method: 'POST' }));
      toast('已發布，公平性次數已結算');
    }
  });

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#scrim').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#sheet').hidden) closeSheet();
      if (drag.active) endDrag();
    }
  });
}

async function boot() {
  bindChrome();
  try {
    await loadWeek(todayIso());
    const today = todayIso();
    const found = Object.entries(state.data.schedule.dates).find(([, d]) => d === today);
    if (found) state.day = Number(found[0]);
    render();
  } catch (error) {
    toast(error.message, 'error');
  }
}

window.addEventListener('error', (e) => toast(e.message ?? '發生未預期錯誤', 'error'));
window.addEventListener('unhandledrejection', (e) => toast(e.reason?.message ?? '操作失敗', 'error'));

boot();
