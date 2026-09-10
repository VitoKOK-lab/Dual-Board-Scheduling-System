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
  strip.hidden = state.tab === 'stats' || state.tab === 'standby';
}

/* ---------- 視圖：黑板 ---------- */

function renderBlackboard() {
  const view = $('#view-blackboard');
  view.replaceChildren();

  if (!state.data.schedule.has_items) { view.append(emptyState()); return; }
  view.classList.add('stagger');

  const openToday = state.data.warnings.filter((w) => w.day_of_week === state.day || w.day_of_week === null);
  if (openToday.length) view.append(noticeEl(`本日尚有 ${openToday.length} 個名額待補`, 'ruby'));

  // 全週固定職務
  const weekCard = el('div', 'card');
  const weekHead = el('div', 'card__title');
  weekHead.append(el('h3', null, '全週固定職務'), badge('1 週 1 次', 'sapphire'));
  weekCard.append(weekHead);
  for (const item of itemsOf('BLACKBOARD', 'ALL_WEEK')) {
    weekCard.append(dutyRow(item, null));
  }
  view.append(weekCard);

  // 每日輪替職務
  const dayCard = el('div', 'card');
  const dayHead = el('div', 'card__title');
  dayHead.append(el('h3', null, '每日輪替職務'), badge(`週${DAY_NAMES[state.day]}`, 'sapphire'));
  dayCard.append(dayHead);
  for (const item of itemsOf('BLACKBOARD', 'DAILY')) {
    dayCard.append(dutyRow(item, state.day));
  }
  view.append(dayCard);

  const away = absencesOn(state.day);
  if (away.length) {
    view.append(noticeEl(`本日公差／請假：${away.map((a) => a.name).join('、')}`, 'topaz'));
  }
}

function dutyRow(item, day) {
  const row = el('div', 'duty');
  row.append(el('span', 'duty__label', item.item_name));
  const slots = el('div', 'duty__slots');
  for (const s of slotsOf(item.item_id, day)) slots.append(tagEl(s, 'BLACKBOARD', day));
  row.append(slots);
  return row;
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

  const accent = SHIFT_COLOR[state.shift];
  const items = itemsOf('WHITEBOARD', state.shift);
  const daySlots = items.flatMap((i) => slotsOf(i.item_id, state.day));
  const filled = daySlots.filter((s) => s.staff_id != null).length;
  const total = items.reduce((sum, i) => sum + i.required_capacity, 0);

  const head = el('div', 'section-head');
  head.append(el('h2', null, `${SHIFT_LABEL[state.shift]} · 週${DAY_NAMES[state.day]}`));
  const meta = el('span', 'section-head__meta');
  meta.append(el('span', 'mono', `${filled}/${total}`), document.createTextNode(' 名額'));
  head.append(meta);
  view.append(head);

  // 升旗底下分「定點」與「巡查」；其他時段沒有分區。
  // 點位以列呈現而非一點一卡——19 個點位攤成 19 張卡要滑很久，
  // 而且實體白板本來就是一行一個點位。
  const groups = new Map();
  for (const item of items) {
    const zone = item.zone || '';
    if (!groups.has(zone)) groups.set(zone, []);
    groups.get(zone).push(item);
  }

  for (const [zone, zoneItems] of groups) {
    if (zone) {
      const zoneHead = el('div', 'zone-head');
      zoneHead.append(el('h3', null, zone));
      view.append(zoneHead);
    }
    const card = el('div', 'card card--flush');
    for (const item of zoneItems) card.append(spotRow(item, accent));
    view.append(card);
  }
}

function spotRow(item, accent) {
  const slots = slotsOf(item.item_id, state.day);
  const on = slots.filter((s) => s.staff_id != null).length;

  const row = el('div', 'spot-row');
  row.append(el('span', 'spot-row__name', item.item_name));

  const tags = el('div', 'spot__tags');
  for (const slot of slots) tags.append(tagEl(slot, state.shift, state.day));
  row.append(tags);

  // 只有一個名額時，名牌本身就說明了滿或缺，不需要再畫刻度
  if (item.required_capacity > 1) {
    const dots = el('div', 'dots');
    for (let i = 0; i < item.required_capacity; i += 1) {
      const d = el('i', `dot${i < on ? ' dot--on' : ''}`);
      if (i < on) d.style.setProperty('--accent', accent);
      dots.append(d);
    }
    row.append(dots);
  }

  return row;
}

/* ---------- 視圖：備援 ---------- */

function renderStandby() {
  const view = $('#view-standby');
  view.replaceChildren();
  view.classList.add('stagger');

  // Plan Y 預備隊
  const planY = el('div', 'card');
  const head = el('div', 'card__title');
  head.append(el('h3', null, 'Plan Y 本週預備隊'), badge('師傅・整週待命', 'topaz'));
  planY.append(head);

  if (state.data.standby.length === 0) {
    planY.append(el('p', 'field__hint', '尚未生成班表，預備隊會在自動排班後產生。'));
  } else {
    const tags = el('div', 'spot__tags');
    for (const s of state.data.standby) {
      const t = tagEl({ detail_id: s.detail_id, staff_id: s.staff_id, is_override: false }, 'STANDBY', null);
      t.dataset.standby = '1';
      tags.append(t);
    }
    planY.append(tags);
    planY.append(el('p', 'field__hint', '這幾位整週不排任何點位與黑板任務，臨時缺人時 Plan X 會優先推薦。待命次數會輪替，不會固定同一批人。'));
    const cap = state.data.capacity;
    if (cap && cap.standby_capacity < 3) {
      planY.append(el('p', 'field__hint', `師傅 ${cap.masters} 位、尖峰時段需要 ${cap.peak_slots} 個名額，最多只能留 ${cap.standby_capacity} 位待命。`));
    }
  }
  view.append(planY);

  // 待補名額
  const gaps = state.data.warnings;
  const gapCard = el('div', 'card');
  const gapHead = el('div', 'card__title');
  gapHead.append(el('h3', null, '待補名額'), badge(String(gaps.length), gaps.length ? 'ruby' : 'emerald'));
  gapCard.append(gapHead);

  if (gaps.length === 0) {
    gapCard.append(el('p', 'field__hint', '所有名額都已排滿。'));
  } else {
    const list = el('div', 'rowlist');
    for (const g of gaps.slice(0, 30)) {
      const row = el('div', 'rowitem');
      const main = el('div', 'rowitem__main');
      const item = state.itemsById.get(g.item_id);
      const shiftName = item && item.board_type === 'WHITEBOARD' ? SHIFT_LABEL[item.shift_type] : '黑板';
      main.append(el('div', 'rowitem__title', g.item_name ?? '未知點位'));
      main.append(el('div', 'rowitem__sub', `${shiftName} · ${g.day_of_week ? `週${DAY_NAMES[g.day_of_week]}` : '全週'}`));
      const btn = el('button', 'btn btn--sm btn--quiet', '補位');
      btn.type = 'button';
      btn.addEventListener('click', () => openPlanX(g.detail_id));
      row.append(main, btn);
      list.append(row);
    }
    gapCard.append(list);
  }
  view.append(gapCard);

  // 公差 / 請假
  const absCard = el('div', 'card');
  const absHead = el('div', 'card__title');
  absHead.append(el('h3', null, '公差／請假'), badge(String(state.data.absences.length), 'topaz'));
  absCard.append(absHead);

  if (state.data.absences.length === 0) {
    absCard.append(el('p', 'field__hint', '本週尚無登錄紀錄。公差僅作行程提示，不計入公平性統計。'));
  } else {
    const list = el('div', 'rowlist');
    for (const a of state.data.absences) {
      const row = el('div', 'rowitem');
      const main = el('div', 'rowitem__main');
      main.append(el('div', 'rowitem__title', a.name));
      main.append(el('div', 'rowitem__sub',
        `${shortDate(a.absence_date)}（週${DAY_NAMES[a.day_of_week] ?? '—'}）· ${a.absence_type === 'OFFICIAL' ? '公差' : '請假'}${a.note ? ` · ${a.note}` : ''}`));
      const del = el('button', 'iconbtn');
      del.type = 'button';
      del.setAttribute('aria-label', `刪除 ${a.name} 的紀錄`);
      del.append(icon('i-trash'));
      del.addEventListener('click', async () => {
        absorb(await api(`/api/absences/${a.absence_id}?week=${state.week}`, { method: 'DELETE' }));
        toast('已刪除紀錄');
      });
      row.append(main, del);
      list.append(row);
    }
    absCard.append(list);
  }

  const addBtn = el('button', 'btn btn--block btn--quiet');
  addBtn.type = 'button';
  addBtn.style.marginTop = '12px';
  addBtn.append(icon('i-calendar'), el('span', null, '登錄公差／請假'));
  addBtn.addEventListener('click', openAbsenceSheet);
  absCard.append(addBtn);
  view.append(absCard);
}

/* ---------- 視圖：統計 ---------- */

/**
 * 輪替均衡度：整數分配下，人人次數相差不超過 1 次即為完全公平（100%）。
 * 差距每多出 1 次，就相對於「最差可能差距」等比扣分。
 *
 * Plan Y 預備隊整週待命是刻意安排，不該被算成「被排得比較少」。
 * 因此計算時把待命週折算回來：每待命一週，補上該維度的每人每週平均值。
 * 環下顯示的 min–max 仍是實際次數，不做修飾。
 */
function balance(rows, key) {
  if (rows.length === 0) return { pct: 100, min: 0, max: 0 };

  const counts = rows.map((r) => r[key]);
  const min = Math.min(...counts);
  const max = Math.max(...counts);

  const weeks = state.data.published_weeks ?? 0;
  const perWeek = weeks > 0 ? counts.reduce((sum, n) => sum + n, 0) / (rows.length * weeks) : 0;
  const adjusted = rows.map((r) => r[key] + (r.standby_count ?? 0) * perWeek);

  const spread = Math.max(...adjusted) - Math.min(...adjusted);
  if (spread <= 1) return { pct: 100, min, max };
  const worst = Math.max(1, Math.max(...adjusted) - 1);
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
    list.append(line('可留待命人數', cap.standby_capacity, `師傅數減去尖峰名額 ${cap.peak_slots}`));
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
    card.append(el('p', 'field__hint', '人人次數相差不超過 1 次即為 100%，Plan Y 待命週已折算回來；環下數字為實際的最少與最多次數。'));
    view.append(card);
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
      nameWrap.append(el('span', null, r.standby_count ? `${sub}・待命 ${r.standby_count}` : sub));
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
  wrap.append(el('p', null, '按下方中央的按鈕，系統會依歷史次數由少到多自動填滿黑板與白板，並選出 Plan Y 預備隊。'));
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
    body.append(el('p', 'field__hint', '只有師傅能排班，因此名單僅列出師傅。Plan X 依序推薦 Plan Y 預備隊與負擔最輕者；主管可強制指派，衝突僅提示不阻擋。'));

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
  const btn = el('button', `cand${c.is_standby ? ' cand--best' : ''}`);
  btn.type = 'button';

  const main = el('div', 'cand__main');
  main.append(el('div', 'cand__name', c.name));

  // 只在有話要說時才加標籤：預備隊身分、或會踩到的限制
  if (c.is_standby || c.conflicts.length) {
    const why = el('div', 'cand__why');
    if (c.is_standby) why.append(badge('Plan Y 預備隊', 'topaz'));
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
  openSheet('登錄公差／請假', '僅作行程提示，不影響公平性統計', (body) => {
    const staffField = el('div', 'field');
    const staffLabel = el('label', null, '人員');
    staffLabel.setAttribute('for', 'absStaff');
    const staffSelect = el('select');
    staffSelect.id = 'absStaff';
    for (const s of state.data.staff.filter((s) => s.is_active)) {
      staffSelect.append(new Option(s.name, String(s.staff_id)));
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
    ? `${person.staff_group} · 師傅 · 累計 ${total} 次任務 · 待命 ${person.standby_count ?? 0} 次`
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
  if (!tag || tag.dataset.standby === '1' || tag.classList.contains('tag--empty')) return;
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
    if (over && Number(over.dataset.detailId) !== drag.fromId && over.dataset.standby !== '1') {
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
  if (tag.dataset.standby === '1') { toast('預備隊成員請由待補名額指派'); return; }
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
  else if (state.tab === 'standby') renderStandby();
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
    const gaps = result.generationWarnings?.filter((w) => w.code === 'UNDERSTAFFED').length ?? 0;
    toast(gaps ? `排班完成，${gaps} 個名額人力不足` : '排班完成，已選出 Plan Y 預備隊');
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
