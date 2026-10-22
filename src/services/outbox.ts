// Outbox: заявки, которые не доехали до CRM, досылаются фоном (день 9, D-011).
// Запись в нашей БД первична: даже если CRM лежит, клиент уже записан.

import { pool } from './db';
import {createLead, createTask} from './crm';

const MINUTE = 60_000;
const BATCH = 10;               // сколько заявок берём за один проход

/**
 * Пробует отправить недоставленные заявки. Вызывается по таймеру,
 * но можно позвать и вручную — так проще проверять руками.
 */
export async function flushOutbox(): Promise<number> {
  const due = await pool.query(
    `SELECT id, payload FROM crm_outbox
      WHERE NOT done AND next_try_at <= now()
      ORDER BY id
      LIMIT $1`,
    [BATCH],
  );

  let sent = 0;
  for (const row of due.rows) {
    try {
      const { kind, ...body } = row.payload;              // kind есть только в outbox
      if (kind === 'task') await createTask(body);
      else await createLead(body);
      await pool.query('UPDATE crm_outbox SET done = true WHERE id = $1', [row.id]);
      sent++;
    } catch {
      // Не доехало: откладываем. Пауза растёт с каждой попыткой, но не больше часа.
      await pool.query(
        `UPDATE crm_outbox
            SET attempts = attempts + 1,
                next_try_at = now() + make_interval(mins => LEAST(attempts + 1, 60))
          WHERE id = $1`,
        [row.id],
      );
    }
  }
  return sent;
}

/** Фоновая задача: раз в минуту пробует дослать застрявшие заявки. */
export function startOutboxWorker(): void {
  // первый проход сразу, дальше — по таймеру
  const log = (e: unknown) => console.error('outbox:', (e as NodeJS.ErrnoException).code ?? String(e));
  void flushOutbox().catch(log);
  const timer = setInterval(() => { void flushOutbox().catch(log); }, MINUTE);
  timer.unref();   // таймер не должен сам удерживать процесс
}
