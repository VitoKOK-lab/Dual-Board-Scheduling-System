#!/usr/bin/env node
/** 重建本機資料庫（刪除既有檔案後重新建表與種子資料）。 */
import { rmSync } from 'node:fs';
import { DEFAULT_DB_PATH, openDatabase } from '../src/db/index.js';

for (const suffix of ['', '-wal', '-shm']) {
  rmSync(`${DEFAULT_DB_PATH}${suffix}`, { force: true });
}

const db = openDatabase(DEFAULT_DB_PATH, { seed: true });
const staff = db.prepare('SELECT COUNT(*) AS n FROM staff').get().n;
const items = db.prepare('SELECT COUNT(*) AS n FROM location_tasks').get().n;
db.close();

console.log(`資料庫已重建：${DEFAULT_DB_PATH}`);
console.log(`  人員 ${staff} 位、點位／任務 ${items} 項`);
