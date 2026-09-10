/** REST API 路由定義。 */

import { Router } from './router.js';
import * as schedule from '../services/scheduleService.js';
import * as repo from '../services/repository.js';
import { currentWeekStart, dateForDay, isIsoDate, mondayOf, shiftWeeks } from '../domain/week.js';
import { BOARD, ROLE, SHIFT, ZONE } from '../domain/constants.js';

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function requireWeek(value) {
  const week = value ?? currentWeekStart();
  if (!isIsoDate(week)) throw bad('week 參數需為 YYYY-MM-DD');
  return mondayOf(week);
}

function requireInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw bad(`${field} 需為整數`);
  return n;
}

function requireOneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw bad(`${field} 需為 ${allowed.join(' / ')}`);
  return value;
}

function requireName(value, field = 'name') {
  const name = String(value ?? '').trim();
  if (!name) throw bad(`${field} 不可為空`);
  if (name.length > 40) throw bad(`${field} 不可超過 40 字`);
  return name;
}

export function buildRouter(db) {
  const router = new Router();

  // ---- 週檢視 ----
  router.get('/api/week', ({ query }) => schedule.getWeekView(db, requireWeek(query.get('week'))));

  router.get('/api/week/navigate', ({ query }) => {
    const week = requireWeek(query.get('week'));
    const delta = Number(query.get('delta') ?? 0);
    if (!Number.isInteger(delta)) throw bad('delta 需為整數');
    return schedule.getWeekView(db, shiftWeeks(week, delta));
  });

  // ---- 一鍵自動排班 ----
  router.post('/api/week/generate', ({ body }) => {
    const week = requireWeek(body.week);
    const standbyCount = body.standby_count ?? 3;
    return schedule.generate(db, week, { standbyCount });
  });

  // ---- 發布 / 撤回 ----
  router.post('/api/schedules/:id/publish', ({ params }) => schedule.publish(db, requireInt(params.id, 'schedule_id')));
  router.post('/api/schedules/:id/unpublish', ({ params }) => schedule.unpublish(db, requireInt(params.id, 'schedule_id')));

  // ---- 名額覆寫 / 互換 / Plan X ----
  router.patch('/api/assignments/:detailId', ({ params, body }) => {
    const detailId = requireInt(params.detailId, 'detail_id');
    const staffId = body.staff_id === null || body.staff_id === undefined
      ? null
      : requireInt(body.staff_id, 'staff_id');
    return schedule.overrideAssignment(db, detailId, staffId);
  });

  router.post('/api/assignments/swap', ({ body }) => schedule.swapAssignments(
    db,
    requireInt(body.detail_id_a, 'detail_id_a'),
    requireInt(body.detail_id_b, 'detail_id_b'),
  ));

  router.get('/api/assignments/:detailId/plan-x', ({ params, query }) => schedule.planXRecommendations(
    db,
    requireInt(params.detailId, 'detail_id'),
    { limit: Number(query.get('limit') ?? 8) },
  ));

  // ---- 公差 / 請假 ----
  router.get('/api/absences', ({ query }) => {
    const week = requireWeek(query.get('week'));
    return { absences: repo.listAbsences(db, week, dateForDay(week, 5)) };
  });

  router.post('/api/absences', ({ body }) => {
    if (!isIsoDate(body.absence_date)) throw bad('absence_date 需為 YYYY-MM-DD');
    const type = body.absence_type ?? 'OFFICIAL';
    if (!['OFFICIAL', 'LEAVE'].includes(type)) throw bad('absence_type 需為 OFFICIAL 或 LEAVE');
    repo.createAbsence(db, {
      staffId: requireInt(body.staff_id, 'staff_id'),
      absenceDate: body.absence_date,
      absenceType: type,
      note: body.note ?? null,
    });
    return schedule.getWeekView(db, mondayOf(body.absence_date));
  });

  router.delete('/api/absences/:id', ({ params, query }) => {
    repo.deleteAbsence(db, requireInt(params.id, 'absence_id'));
    return schedule.getWeekView(db, requireWeek(query.get('week')));
  });

  // ---- 點位與任務設定 ----
  router.get('/api/items', () => ({ items: repo.listItems(db) }));

  router.post('/api/items', ({ body }) => {
    const boardType = requireOneOf(body.board_type, Object.values(BOARD), 'board_type');
    const shiftType = requireOneOf(body.shift_type, Object.values(SHIFT), 'shift_type');

    if (boardType === BOARD.WHITEBOARD && ![SHIFT.MORNING, SHIFT.FLAG, SHIFT.NOON].includes(shiftType)) {
      throw bad('白板時段需為 MORNING / FLAG / NOON');
    }
    if (boardType === BOARD.BLACKBOARD && ![SHIFT.ALL_WEEK, SHIFT.DAILY].includes(shiftType)) {
      throw bad('黑板時段需為 ALL_WEEK / DAILY');
    }

    const capacity = requireInt(body.required_capacity ?? 1, 'required_capacity');
    if (capacity < 1 || capacity > 20) throw bad('required_capacity 需介於 1~20');

    const zone = String(body.zone ?? '').trim();
    if (zone && !Object.values(ZONE).includes(zone)) throw bad(`zone 需為 ${Object.values(ZONE).join(' / ')}`);

    try {
      const itemId = repo.createItem(db, {
        boardType, shiftType, itemName: requireName(body.item_name, 'item_name'), requiredCapacity: capacity, zone,
      });
      return { item_id: itemId, items: repo.listItems(db) };
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw bad('這個時段已經有同名點位');
      throw error;
    }
  });

  router.patch('/api/items/:id', ({ params, body }) => {
    const itemId = requireInt(params.id, 'item_id');
    if (!repo.findItem(db, itemId)) throw Object.assign(new Error('點位不存在'), { status: 404 });

    const patch = {};
    if (body.item_name !== undefined) patch.itemName = requireName(body.item_name, 'item_name');
    if (body.required_capacity !== undefined) {
      const capacity = requireInt(body.required_capacity, 'required_capacity');
      if (capacity < 1 || capacity > 20) throw bad('required_capacity 需介於 1~20');
      patch.requiredCapacity = capacity;
    }
    if (body.zone !== undefined) {
      const zone = String(body.zone).trim();
      if (zone && !Object.values(ZONE).includes(zone)) throw bad(`zone 需為 ${Object.values(ZONE).join(' / ')}`);
      patch.zone = zone;
    }
    if (body.sort_order !== undefined) patch.sortOrder = requireInt(body.sort_order, 'sort_order');

    try {
      repo.updateItem(db, itemId, patch);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw bad('這個時段已經有同名點位');
      throw error;
    }
    return { items: repo.listItems(db) };
  });

  router.delete('/api/items/:id', ({ params }) => {
    const itemId = requireInt(params.id, 'item_id');
    const item = repo.findItem(db, itemId);
    if (!item) throw Object.assign(new Error('點位不存在'), { status: 404 });

    const affected = repo.countItemAssignments(db, itemId);
    repo.deleteItem(db, itemId);
    return { items: repo.listItems(db), removed_assignments: affected };
  });

  // ---- 人員 ----
  router.get('/api/staff', () => ({
    staff: repo.listStaff(db),
    groups: repo.listGroups(db),
    fairness: repo.listFairness(db),
  }));

  router.post('/api/staff', ({ body }) => {
    const name = requireName(body.name);
    const staffGroup = String(body.staff_group ?? '').trim();
    const role = requireOneOf(body.role ?? ROLE.APPRENTICE, Object.values(ROLE), 'role');
    return {
      staff_id: repo.createStaff(db, name, staffGroup, role),
      staff: repo.listStaff(db),
      groups: repo.listGroups(db),
    };
  });

  router.patch('/api/staff/:id', ({ params, body }) => {
    const staffId = requireInt(params.id, 'staff_id');

    if (body.name !== undefined) repo.renameStaff(db, staffId, requireName(body.name));
    if (body.role !== undefined) {
      repo.setStaffRole(db, staffId, requireOneOf(body.role, Object.values(ROLE), 'role'));
    }
    if (body.is_active !== undefined) {
      repo.setStaffActive(db, staffId, Boolean(body.is_active));
    }
    return { staff: repo.listStaff(db), fairness: repo.listFairness(db), groups: repo.listGroups(db) };
  });

  router.delete('/api/staff/:id', ({ params }) => {
    const staffId = requireInt(params.id, 'staff_id');
    if (!repo.listStaff(db).some((s) => s.staff_id === staffId)) {
      throw Object.assign(new Error('人員不存在'), { status: 404 });
    }
    const affected = repo.countStaffAssignments(db, staffId);
    repo.deleteStaff(db, staffId);
    return { staff: repo.listStaff(db), groups: repo.listGroups(db), vacated_slots: affected };
  });

  return router;
}
