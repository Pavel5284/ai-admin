import 'dotenv/config';
import { step } from './dialog/machine';
import { newCtx, type BotEvent } from './dialog/states';
import { loadCtx, saveCtx, logTurn } from './services/sessions';
import { executeActions } from './services/actions';

const queues = new Map<string, Promise<unknown>>();   // очередь сообщений по сессии

export function handleEvent(sessionId: string, ev: BotEvent, now = new Date()): Promise<string[]> {
  const prev = queues.get(sessionId) ?? Promise.resolve();
  const run = prev.then(async () => {
    const t0 = Date.now();
    let ctx = await loadCtx(sessionId);
    if (!ctx || ctx.state === 'DONE') ctx = newCtx(sessionId, now);   // завершённый диалог: начинаем новый
    const from = ctx.state;

    const result = await step(ctx, ev, now);
    const extra = await executeActions(result.ctx, result.actions);
    await saveCtx(result.ctx);

    const say = [...result.say, ...extra];
    await logTurn({
      sessionId, stateFrom: from, stateTo: result.ctx.state,
      userText: ev.type === 'user_text' ? ev.text : '[' + ev.type + ']',
      botText: say.join(' / '), latencyMs: Date.now() - t0,
      nlu: result.nlu,
    });
    return say;
  });
  queues.set(sessionId, run.catch(() => undefined));     // ошибка одного шага не ломает очередь
  return run;
}
