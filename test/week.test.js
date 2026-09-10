import test from 'node:test';
import assert from 'node:assert/strict';
import { currentWeekStart, dateForDay, dayOfWeekFor, isIsoDate, mondayOf, shiftWeeks } from '../src/domain/week.js';

test('mondayOf 把一週任何一天都收斂到該週週一', () => {
  assert.equal(mondayOf('2026-09-07'), '2026-09-07'); // 週一
  assert.equal(mondayOf('2026-09-11'), '2026-09-07'); // 週五
  assert.equal(mondayOf('2026-09-12'), '2026-09-07'); // 週六
});

test('mondayOf 把週日歸屬到前一週的週一', () => {
  assert.equal(mondayOf('2026-09-13'), '2026-09-07');
});

test('dateForDay 與 dayOfWeekFor 互為反函式', () => {
  for (const day of [1, 2, 3, 4, 5]) {
    const date = dateForDay('2026-09-07', day);
    assert.equal(dayOfWeekFor('2026-09-07', date), day);
  }
});

test('dayOfWeekFor 對週末與跨週日期回傳 null', () => {
  assert.equal(dayOfWeekFor('2026-09-07', '2026-09-12'), null);
  assert.equal(dayOfWeekFor('2026-09-07', '2026-09-14'), null);
});

test('shiftWeeks 以 7 天為單位位移', () => {
  assert.equal(shiftWeeks('2026-09-07', 1), '2026-09-14');
  assert.equal(shiftWeeks('2026-09-07', -2), '2026-08-24');
});

test('dateForDay 拒絕範圍外的 day_of_week', () => {
  assert.throws(() => dateForDay('2026-09-07', 6));
  assert.throws(() => dateForDay('2026-09-07', 0));
});

test('isIsoDate 只接受合法的 YYYY-MM-DD', () => {
  assert.equal(isIsoDate('2026-09-07'), true);
  assert.equal(isIsoDate('2026-9-7'), false);
  assert.equal(isIsoDate('2026-13-01'), false);
  assert.equal(isIsoDate(null), false);
});

test('currentWeekStart 回傳週一', () => {
  assert.equal(currentWeekStart(new Date('2026-09-10T15:00:00Z')), '2026-09-07');
});
