import { pool } from './db';
import { cancelBooking, createBooking, rescheduleBooking } from './slots';
import { createLead, createTask } from './crm';
import type { Ctx, Action } from '../dialog/states';

export async function executeActions(ctx: Ctx, actions: Action[]): Promise<string[]> {
  const extra: string[] = [];
  for (const a of actions) {
    if (a.type === 'create_booking') {
      const r = await createBooking(a.slots);       // возвращает { ok: true, id } или { ok: false, reason }
      if (!r.ok) {
        extra.push('К сожалению, это время только что заняли. Давайте выберем другое.');
        ctx.state = 'OFFER_SLOTS';
        // Запись не создана — «booked» здесь был бы ложью и испортил бы метрику.
        delete ctx.outcome;
        continue;
      }
      try {
        await createLead({ bookingId: r.id, ...a.slots });
      } catch {
        // CRM недоступна: запись уже в нашей БД, заявку досылает outbox-воркер
        await pool.query('INSERT INTO crm_outbox (payload) VALUES ($1)',
          [JSON.stringify({ kind: 'lead', bookingId: r.id, ...a.slots })]);
      }
    }
    if (a.type === 'cancel_booking') {
      const done = await cancelBooking(a.id);
      if (!done) extra.push('Не удалось отменить запись. Позвоните администратору.');
    }
    if (a.type === 'reschedule_booking') {
      const service = await serviceDuration(ctx.slots.service);
      const r = await rescheduleBooking(a.id, a.date, a.time, service);
      if (!r.ok) {
        extra.push(r.reason === 'slot_taken'
          ? 'Это время только что заняли. Давайте выберем другое.'
          : 'Не удалось перенести запись. Позвоните администратору.');
        if (r.reason === 'slot_taken') {
          // Возвращаемся к выбору окна, сохраняя запись и режим переноса:
          // иначе следующее «да» создаст новую запись вместо переноса.
          ctx.state = 'OFFER_SLOTS';
          ctx.pending = 'reschedule';
          ctx.bookingId = a.id;
          delete ctx.outcome;
        } else {
          delete ctx.outcome;
        }
      } else {
        // Перенос удался: старую запись больше не держим в контексте.
        delete ctx.pending;
        delete ctx.bookingId;
      }
    }
    if (a.type === 'handoff') {
      const task = {
        reason: a.reason,
        ...(a.contact ? { contact: a.contact } : {}),
        sessionId: ctx.sessionId,
        lastTurns: ctx.history.slice(-10),
      };
      try {
        await createTask(task);
      } catch {
        // «Передаю администратору» без задачи — потерянный клиент, поэтому в outbox
        await pool.query('INSERT INTO crm_outbox (payload) VALUES ($1)',
          [JSON.stringify({ kind: 'task', ...task })]);
      }
    }
  }
  return extra;
}

/** Длительность услуги — нужна, чтобы посчитать конец перенесённой записи. */
async function serviceDuration(code?: string): Promise<number> {
  if (!code) return 60;
  const { rows } = await pool.query('SELECT duration_min FROM services WHERE code = $1', [code]);
  return rows[0]?.duration_min ?? 60;
}
