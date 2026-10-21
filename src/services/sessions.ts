import { pool } from './db';
import type { Ctx } from '../dialog/states';

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
