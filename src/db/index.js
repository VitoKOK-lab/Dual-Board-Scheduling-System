import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

export const DEFAULT_DB_PATH = process.env.DB_PATH ?? join(ROOT, 'data', 'scheduling.db');

let instance = null;

function runScript(db, fileName) {
  db.exec(readFileSync(join(HERE, fileName), 'utf8'));
}

/**
 * 開啟資料庫連線；不存在時自動建表。
 * @param {string} path ':memory:' 可用於測試
 * @param {{ seed?: boolean }} options
 */
export function openDatabase(path = DEFAULT_DB_PATH, { seed = true } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  runScript(db, 'schema.sql');
  migrate(db);

  if (seed) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM location_tasks').get();
    if (n === 0) runScript(db, 'seed.sql');
  }

  return db;
}

/**
 * 針對既有資料庫補上後來新增的欄位。
 * schema.sql 用的是 CREATE TABLE IF NOT EXISTS，不會自動改動已存在的表。
 */
function migrate(db) {
  const additions = [
    ['staff', 'staff_group', "TEXT NOT NULL DEFAULT ''"],
    ['staff', 'sort_order', 'INTEGER NOT NULL DEFAULT 0'],
    ['staff', 'role', "TEXT NOT NULL DEFAULT 'APPRENTICE'"],
    ['location_tasks', 'zone', "TEXT NOT NULL DEFAULT ''"],
    ['fairness_stats', 'flag_whiteboard_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['fairness_ledger', 'flag_delta', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [table, column, definition] of additions) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** 應用程式單例連線。 */
export function getDatabase() {
  if (!instance) instance = openDatabase();
  return instance;
}

/** 以交易包裹一段寫入操作。 */
export function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
