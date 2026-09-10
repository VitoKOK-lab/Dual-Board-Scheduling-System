-- =============================================================
-- 雙板動態排班系統 Schema (SQLite 方言)
-- 對應規格書 §3 資料庫設計。MySQL 的 AUTO_INCREMENT / ENUM 在
-- SQLite 以 INTEGER PRIMARY KEY + CHECK 約束等價表達。
-- =============================================================

PRAGMA foreign_keys = ON;

-- 1. 人員表
CREATE TABLE IF NOT EXISTS staff (
    staff_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    staff_group TEXT    NOT NULL DEFAULT '',   -- 組別，如「高一組」「高二組」
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    sort_order  INTEGER NOT NULL DEFAULT 0     -- 名冊原始順序
);

CREATE INDEX IF NOT EXISTS idx_staff_group ON staff (staff_group);

-- 2. 點位與任務字典表
CREATE TABLE IF NOT EXISTS location_tasks (
    item_id            INTEGER PRIMARY KEY AUTOINCREMENT,
    board_type         TEXT    NOT NULL CHECK (board_type IN ('WHITEBOARD', 'BLACKBOARD')),
    shift_type         TEXT    NOT NULL CHECK (shift_type IN ('MORNING', 'NOON', 'ALL_WEEK', 'DAILY')),
    item_name          TEXT    NOT NULL,
    required_capacity  INTEGER NOT NULL DEFAULT 1 CHECK (required_capacity >= 1),
    sort_order         INTEGER NOT NULL DEFAULT 0,
    UNIQUE (board_type, shift_type, item_name)
);

-- 3. 公平性歷史統計表 (演算法核心)
CREATE TABLE IF NOT EXISTS fairness_stats (
    stat_id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id                 INTEGER NOT NULL UNIQUE REFERENCES staff (staff_id) ON DELETE CASCADE,
    blackboard_count         INTEGER NOT NULL DEFAULT 0,
    morning_whiteboard_count INTEGER NOT NULL DEFAULT 0,
    noon_whiteboard_count    INTEGER NOT NULL DEFAULT 0
);

-- 4. 週班表主表
CREATE TABLE IF NOT EXISTS weekly_schedules (
    schedule_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start_date TEXT    NOT NULL UNIQUE,             -- ISO 'YYYY-MM-DD'，一律為週一
    status          TEXT    NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED')),
    generated_at    TEXT,
    published_at    TEXT
);

-- 5. 班表明細表 (含 Plan B 標記)
CREATE TABLE IF NOT EXISTS schedule_items (
    detail_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id        INTEGER NOT NULL REFERENCES weekly_schedules (schedule_id) ON DELETE CASCADE,
    staff_id           INTEGER REFERENCES staff (staff_id) ON DELETE SET NULL,
    item_id            INTEGER REFERENCES location_tasks (item_id) ON DELETE CASCADE,
    day_of_week        INTEGER CHECK (day_of_week BETWEEN 1 AND 5),  -- NULL = 全週職務 / 預備隊
    is_plan_b_standby  INTEGER NOT NULL DEFAULT 0 CHECK (is_plan_b_standby IN (0, 1)),
    is_override        INTEGER NOT NULL DEFAULT 0 CHECK (is_override IN (0, 1)),
    slot_index         INTEGER NOT NULL DEFAULT 0        -- 同點位內第幾個名額，供前端穩定排序
);

CREATE INDEX IF NOT EXISTS idx_schedule_items_schedule ON schedule_items (schedule_id);
CREATE INDEX IF NOT EXISTS idx_schedule_items_staff    ON schedule_items (staff_id);

-- ---------------------------------------------------------------
-- 以下兩表為規格書 §5（已知公差登錄）與 §4.5（發布結算）所必需，
-- 屬 §3 的實作補充。
-- ---------------------------------------------------------------

-- 6. 公差 / 請假事件（規格 §2.2：僅作行程紀錄與提示，不計入公平性）
CREATE TABLE IF NOT EXISTS staff_absences (
    absence_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id     INTEGER NOT NULL REFERENCES staff (staff_id) ON DELETE CASCADE,
    absence_date TEXT    NOT NULL,                       -- ISO 'YYYY-MM-DD'
    absence_type TEXT    NOT NULL DEFAULT 'OFFICIAL' CHECK (absence_type IN ('OFFICIAL', 'LEAVE')),
    note         TEXT,
    UNIQUE (staff_id, absence_date)
);

CREATE INDEX IF NOT EXISTS idx_absences_date ON staff_absences (absence_date);

-- 7. 公平性結算帳本：記錄每次「發布」對 fairness_stats 的增量，
--    重複發布時先沖銷舊帳再結新帳，確保結算冪等且可稽核。
CREATE TABLE IF NOT EXISTS fairness_ledger (
    ledger_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id   INTEGER NOT NULL REFERENCES weekly_schedules (schedule_id) ON DELETE CASCADE,
    staff_id      INTEGER NOT NULL REFERENCES staff (staff_id) ON DELETE CASCADE,
    blackboard_delta INTEGER NOT NULL DEFAULT 0,
    morning_delta    INTEGER NOT NULL DEFAULT 0,
    noon_delta       INTEGER NOT NULL DEFAULT 0,
    applied_at    TEXT NOT NULL,
    UNIQUE (schedule_id, staff_id)
);
