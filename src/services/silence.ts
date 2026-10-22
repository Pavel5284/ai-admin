/**
 * Спящий клиент (день 14 гайда, раздел 3.5).
 *
 * Раз в минуту ищет сессии, в которые клиент не писал 15 минут, и отправляет
 * автомату событие `silence`: напоминание → повторить вопрос → вежливое
 * закрытие с сохранением слотов (`onSilence`). События идут через тот же
 * `handleEvent`, поэтому реакция одинакова во всех каналах (D-015), а
 * updated_at после сохранения паузы сдвигается: новый вопрос уйдёт не раньше
 * чем ещё через 15 минут. Сессии старше суток считаются закрытыми и удаляются.
 */

import { pool } from './db';
import { handleEvent } from '../index';

const EVERY_MS = 60_000;
const SILENCE_AFTER = '15 minutes';
const CLOSE_AFTER = '24 hours';

let busy = false;                                    // повторный тик на течение предыдущего не допускается

export function startSilenceWorker(): void {
  setInterval(() => { void tick(); }, EVERY_MS).unref();
  void tick();
}

async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    // Сессии, в которые клиент не писал сутки, закрываем.
    await pool.query(`DELETE FROM sessions WHERE updated_at < now() - interval '${CLOSE_AFTER}'`);

    // Живые сессии без новости больше 15 минут: повод отреагировать на молчание.
    // У DONE не зовём: диалог уже закончен.
    const { rows } = await pool.query(
      `SELECT session_id FROM sessions
       WHERE updated_at < now() - interval '${SILENCE_AFTER}'
         AND ctx->>'state' IS NOT NULL AND ctx->>'state' <> 'DONE'`,
    );
    for (const row of rows) {
      try {
        await handleEvent(row.session_id, { type: 'silence', ms: 15 * 60_000 });
      } catch (e) {
        console.error('silence worker:', row.session_id, (e as Error).message);
      }
    }
  } finally {
    busy = false;
  }
}
