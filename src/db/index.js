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

  if (seed) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM location_tasks').get();
    if (n === 0) runScript(db, 'seed.sql');
  }

  return db;
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
