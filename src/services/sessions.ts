import { pool } from './db';
import type { Ctx } from '../dialog/states';

/**
 * Сколько сессия считается живой. Если клиент вернулся после долгой паузы,
 * начинаем диалог заново: старые слоты, дата и «перенос» уже неактуальны.
 * По умолчанию 2 часа; настраивается через SESSION_TTL_MIN.
 */
export function sessionTtlMs(): number {
  const min = Number(process.env.SESSION_TTL_MIN ?? 120);
  return (Number.isFinite(min) && min > 0 ? min : 120) * 60_000;
}

/** Сессия устарела: клиент молчал дольше TTL. Завершённые (DONE) не считаем. */
export function isSessionExpired(ctx: Ctx, now: Date): boolean {
  if (ctx.state === 'DONE') return false;
  return now.getTime() - (ctx.lastActivityAt ?? 0) > sessionTtlMs();
}

export async function deleteSession(id: string): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE session_id = $1', [id]);
}

export async function loadCtx(id: string): Promise<Ctx | null> {
  const { rows } = await pool.query('SELECT ctx FROM sessions WHERE session_id = $1', [id]);
  return rows[0]?.ctx ?? null;
}

export async function saveCtx(ctx: Ctx): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (session_id, ctx, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (session_id) DO UPDATE SET ctx = EXCLUDED.ctx, updated_at = now()`,
    [ctx.sessionId, JSON.stringify(ctx)],
  );
}

export async function logTurn(r: {
  sessionId: string; stateFrom: string; stateTo: string;
  userText: string; botText: string; latencyMs: number; nlu?: unknown;
}): Promise<void> {
  await pool.query(
    `INSERT INTO dialog_log (session_id, state_from, state_to, user_text, bot_text, latency_ms, nlu)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [r.sessionId, r.stateFrom, r.stateTo, r.userText, r.botText, r.latencyMs,
     r.nlu ? JSON.stringify(r.nlu) : null],
  );
}
