/* ============================================================
   資料層 —— 取代原本的 SQLite + REST API
   同一份領域邏輯（排班引擎、公平性、Plan X）原封不動沿用，
   只把「資料放哪裡」換成 Artifact 的 db 能力，
   沒有 db 時退回瀏覽器本機儲存。
   ============================================================ */

const STORAGE_KEY = 'dual-board-v1';

const STATE = {
  staff: [],
  items: [],
  fairness: {},          // staff_id -> 累計次數
  weeks: {},             // 'YYYY-MM-DD' -> { status, rows, absences, ledger, ... }
  nextIds: { staff: 1, item: 1, detail: 1, absence: 1 },
};

let remoteDb = null;     // claude.use('db') 的結果，null 代表只能用本機
let loadedWeeks = new Set();

const clone = (v) => JSON.parse(JSON.stringify(v));

/* ---------- 持久化 ---------- */

function localRead(key) {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}:${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function localWrite(key, value) {
  try { localStorage.setItem(`${STORAGE_KEY}:${key}`, JSON.stringify(value)); } catch { /* 私密瀏覽或空間不足 */ }
}

async function readDoc(path) {
  if (remoteDb) {
    try {
      const snap = await remoteDb.doc(path).get();
      if (snap?.exists) return snap.data();
    } catch { /* 讀不到就退回本機 */ }
  }
  return localRead(path);
}

async function writeDoc(path, value) {
  localWrite(path, value);
  if (remoteDb) {
    try { await remoteDb.doc(path).set(value); } catch { /* 寫不進去至少本機還在 */ }
  }
}

const configDoc = () => ({
  staff: STATE.staff, items: STATE.items, fairness: STATE.fairness, nextIds: STATE.nextIds,
});

const weekDoc = (week) => STATE.weeks[week] ?? null;

async function saveConfig() { await writeDoc('app/config', configDoc()); }

async function saveWeek(week) {
  if (STATE.weeks[week]) await writeDoc(`weeks/${week}`, STATE.weeks[week]);
}

/** 開機：連上 db（若有），載入設定。 */
async function initStore() {
  try { remoteDb = await window.claude?.use?.('db') ?? null; } catch { remoteDb = null; }

  const config = await readDoc('app/config');
  if (config) {
    STATE.staff = config.staff ?? [];
    STATE.items = config.items ?? [];
    STATE.fairness = config.fairness ?? {};
    STATE.nextIds = { staff: 1, item: 1, detail: 1, absence: 1, ...(config.nextIds ?? {}) };
  }
  return { synced: Boolean(remoteDb) };
}

async function ensureWeekLoaded(week) {
  if (loadedWeeks.has(week)) return;
  const doc = await readDoc(`weeks/${week}`);
  if (doc) STATE.weeks[week] = doc;
  loadedWeeks.add(week);
}

const nextId = (kind) => { const id = STATE.nextIds[kind]; STATE.nextIds[kind] = id + 1; return id; };

/* ---------- 查詢（對應原本的 repository） ---------- */

const sortedStaff = () => [...STATE.staff].sort((a, b) => a.sort_order - b.sort_order || a.staff_id - b.staff_id);

const sortedItems = () => [...STATE.items].sort((a, b) => (
  a.board_type.localeCompare(b.board_type)
  || a.shift_type.localeCompare(b.shift_type)
  || a.sort_order - b.sort_order
  || a.item_id - b.item_id
));

function blankStat() {
  return {
    blackboard_count: 0,
    morning_whiteboard_count: 0,
    flag_whiteboard_count: 0,
    noon_whiteboard_count: 0,
    standby_count: 0,
  };
}

const statOf = (staffId) => {
  if (!STATE.fairness[staffId]) STATE.fairness[staffId] = blankStat();
  return STATE.fairness[staffId];
};

const listFairness = () => sortedStaff().map((s) => ({
  staff_id: s.staff_id, name: s.name, staff_group: s.staff_group, role: s.role, is_active: s.is_active,
  ...blankStat(), ...(STATE.fairness[s.staff_id] ?? {}),
}));

function listGroups() {
  const order = new Map();
  const totals = new Map();
  for (const s of sortedStaff()) {
    if (!s.staff_group) continue;
    if (!order.has(s.staff_group)) order.set(s.staff_group, s.sort_order);
    const t = totals.get(s.staff_group) ?? { name: s.staff_group, total: 0, active_total: 0, master_total: 0 };
    t.total += 1;
    if (s.is_active) t.active_total += 1;
    if (s.role === 'MASTER') t.master_total += 1;
    totals.set(s.staff_group, t);
  }
  return [...totals.values()].sort((a, b) => order.get(a.name) - order.get(b.name));
}

const countMasters = () => STATE.staff.filter((s) => s.is_active && s.role === 'MASTER').length;

const countPublishedWeeks = () => Object.values(STATE.weeks).filter((w) => w.status === 'PUBLISHED').length;

function ensureWeek(week) {
  if (!STATE.weeks[week]) {
    STATE.weeks[week] = {
      week_start_date: week, status: 'DRAFT', generated_at: null, published_at: null,
      rows: [], absences: [], ledger: {},
    };
  }
  return STATE.weeks[week];
}

const findRow = (week, detailId) => ensureWeek(week).rows.find((r) => r.detail_id === detailId) ?? null;

/** 全域搜尋某個名額屬於哪一週（前端只會操作當前週，但保險起見）。 */
function locateRow(detailId) {
  for (const [week, data] of Object.entries(STATE.weeks)) {
    const row = data.rows.find((r) => r.detail_id === detailId);
    if (row) return { week, row };
  }
  return null;
}
