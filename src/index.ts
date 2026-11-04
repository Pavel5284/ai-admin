import 'dotenv/config';
import { step } from './dialog/machine';
import { humanize, replaceLastBotTurns } from './dialog/humanize';
import { newCtx, telegramIdFromSession, type BotEvent } from './dialog/states';
import { loadCtx, saveCtx, logTurn, deleteSession, isSessionExpired } from './services/sessions';
import { executeActions } from './services/actions';
import { loadCatalog } from './services/slots';

const queues = new Map<string, Promise<unknown>>();   // очередь сообщений по сессии

let catalogReady: Promise<void> | null = null;

/**
 * Каталог услуг и мастеров нужен автомату, поэтому грузим его один раз
 * при первом событии. Если БД недоступна — пробуем снова при следующем.
 */
function ensureCatalog(): Promise<void> {
  if (!catalogReady) {
    catalogReady = loadCatalog().catch((e: unknown) => {
      console.error('не удалось загрузить каталог услуг:', e);
      catalogReady = null;
    });
  }
  return catalogReady;
}

export function handleEvent(sessionId: string, ev: BotEvent, now = new Date()): Promise<string[]> {
  const prev = queues.get(sessionId) ?? Promise.resolve();
  const run = prev.then(async () => {
    const t0 = Date.now();
    await ensureCatalog();
    let ctx = await loadCtx(sessionId);
    // Клиент вернулся после долгой паузы — старый диалог уже неактуален:
    // начинаем с приветствия, а не продолжаем брошенную запись недельной давности.
    // Молчащую сессию не будим: удаляем, чтобы silence-worker не слал «Вы здесь?».
    if (ctx && isSessionExpired(ctx, now)) {
      if (ev.type === 'silence') {
        await deleteSession(sessionId);
        return [];
      }
      console.log('сессия устарела, начинаем диалог заново:', sessionId);
      ctx = null;
    }
    if (!ctx || ctx.state === 'DONE') ctx = newCtx(sessionId, now);   // завершённый диалог: начинаем новый
    // Старые сессии сохранили ctx без telegramId: восстанавливаем из session_id.
    if (ctx.telegramId == null) {
      const telegramId = telegramIdFromSession(sessionId);
      if (telegramId != null) ctx.telegramId = telegramId;
    }
    const from = ctx.state;

    const result = await step(ctx, ev, now);
    const userText = ev.type === 'user_text' || ev.type === 'barge_in' ? ev.text : '';
    const styled = await humanize({
      ctx: result.ctx,
      userText,
      say: result.say,
      // Запись/отмена/передача оператору и ответы из базы уже имеют свой тон.
      enabled: result.humanize !== false && result.actions.length === 0,
    });
    if (styled.length === result.say.length && styled.some((s, i) => s !== result.say[i])) {
      replaceLastBotTurns(result.ctx, result.say, styled);
    }
    const report = await executeActions(result.ctx, result.actions);
    await saveCtx(result.ctx);

    // Если действие не выполнилось, «Готово, вы записаны» — ложь: показываем
    // только сообщение об ошибке и следующий шаг.
    const say = [...(report.failed ? [] : styled), ...report.extra];
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
