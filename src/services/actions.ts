import { pool } from './db';
import { createBooking } from './slots';          // ваша функция из 3.1
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
        continue;
      }
      try {
        await createLead({ bookingId: r.id, ...a.slots });
      } catch {
        // CRM недоступна: запись уже в нашей БД, заявку отправим позже
        await pool.query('INSERT INTO crm_outbox (payload) VALUES ($1)',
          [JSON.stringify({ kind: 'lead', bookingId: r.id, slots: a.slots })]);
      }
    }
    if (a.type === 'handoff') {
      await createTask({ reason: a.reason, sessionId: ctx.sessionId, lastTurns: ctx.history.slice(-10) })
        .catch(() => console.error('handoff task not delivered'));
    }
  }
  return extra;
}
