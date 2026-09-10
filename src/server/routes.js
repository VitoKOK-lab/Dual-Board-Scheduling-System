/** REST API 路由定義。 */

import { Router } from './router.js';
import * as schedule from '../services/scheduleService.js';
import * as repo from '../services/repository.js';
import { currentWeekStart, dateForDay, isIsoDate, mondayOf, shiftWeeks } from '../domain/week.js';

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

  // ---- 人員 ----
  router.get('/api/staff', () => ({ staff: repo.listStaff(db), fairness: repo.listFairness(db) }));

  router.post('/api/staff', ({ body }) => {
    const name = String(body.name ?? '').trim();
    if (!name) throw bad('name 不可為空');
    return { staff_id: repo.createStaff(db, name), staff: repo.listStaff(db) };
  });

  router.patch('/api/staff/:id', ({ params, body }) => {
    repo.setStaffActive(db, requireInt(params.id, 'staff_id'), Boolean(body.is_active));
    return { staff: repo.listStaff(db) };
  });

  return router;
}
