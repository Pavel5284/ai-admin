import type { BotEvent, Ctx, StateId, StepResult } from './states';
import { R, variant } from './replies';
import { normalize } from '../nlu/normalize';

/**
 * Политики диалога: переходы, ответы, глобальные перехваты,
 * реакции на молчание и перебивание. Логика состояний — в machine.ts.
 */

/** Детерминированный выбор варианта реплики: по числу реплик бота в истории. */
export function pick(ctx: Ctx, texts: string[]): string[] {
  if (!texts.length) return [];
  const n = ctx.history.filter((h) => h.role === 'bot').length;
  return [variant(texts, n)];
}

export function say(ctx: Ctx, texts: string[]): StepResult {
  return { ctx, say: pick(ctx, texts), actions: [] };
}

/** Переход в состояние + вопрос клиенту. */
export function goto(ctx: Ctx, state: StateId, texts: string[] = []): StepResult {
  if (ctx.lastAsked && ctx.lastAsked !== state) ctx.prevAsked = ctx.lastAsked;
  ctx.state = state;
  ctx.lastAsked = state;
  ctx.retries[state] = 0;
  return { ctx, say: pick(ctx, texts), actions: [] };
}

/** Передача администратору: сообщение клиенту + задача оператору. */
export function handoff(ctx: Ctx, reason: string, texts: string[] = R.handoff): StepResult {
  ctx.state = 'HANDOFF';
  ctx.lastAsked = 'HANDOFF';
  ctx.outcome = 'handoff';
  return { ctx, say: pick(ctx, texts), actions: [{ type: 'handoff', reason }], humanize: false };
}

/** Не понял: 1 — переспросить с примером, 2 — сузить вопрос, 3 — оператору. */
export function misunderstood(ctx: Ctx, state: StateId): StepResult {
  const n = (ctx.retries[state] ?? 0) + 1;
  ctx.retries[state] = n;
  if (n === 1) return say(ctx, R.rephrase[state] ?? R.generic);
  if (n === 2) return say(ctx, R.narrow[state] ?? R.generic);
  return handoff(ctx, `no_understanding:${state}`);
}

/** «назад» — вернуться к предыдущему слоту. */
export function back(ctx: Ctx): StepResult {
  const target = ctx.prevAsked ?? ctx.lastAsked;
  switch (target) {
    case 'ASK_SERVICE':
      delete ctx.slots.service;
      return goto(ctx, 'ASK_SERVICE', R.askService);
    case 'ASK_DATE':
      delete ctx.slots.date;
      return goto(ctx, 'ASK_DATE', R.askDate);
    case 'ASK_TIME':
      delete ctx.slots.time;
      delete ctx.slots.timeRange;
      return goto(ctx, 'ASK_TIME', R.askTime);
    case 'ASK_CONTACT':
      delete ctx.slots.phone;
      delete ctx.slots.phoneDraft;
      return goto(ctx, 'ASK_CONTACT', R.askPhone);
    case 'ASK_NAME':
      delete ctx.slots.name;
      delete ctx.nameSkipped;
      return goto(ctx, 'ASK_NAME', R.askName);
    default:
      return misunderstood(ctx, ctx.state);
  }
}

/** Глобальные перехваты: работают в любом состоянии. */
export function checkGlobalIntents(ctx: Ctx, ev: BotEvent): StepResult | null {
  if (ev.type !== 'user_text') return null;
  const t = normalize(ev.text);

  // «оператор», «человек», «администратор» → сразу оператору.
  // «Ты человек?» — это вопрос о боте, его разбирает smalltalk, а не эскалация.
  const asksIfBot = /(?:ты|вы)\s+(?:человек|бот|робот)|кто\s+(?:вы|ты)|с\s+кем\s+говорю|живой\s+человек/iu.test(t);
  if (!asksIfBot && /(оператор|администратор|человек|менеджер|живого|живой)/.test(t)) {
    return handoff(ctx, 'client_asked_operator');
  }

  // Жалоба или грубость → сразу оператору, в любом состоянии
  if (/(жалоб|недоволен|недовольн|отвратительн|ужасн|кошмар|идиот|дурак)/.test(t)) {
    return handoff(ctx, 'client_complaint', R.complaint);
  }

  // «повторите» → повтор последней реплики бота
  if (/(повтори|ещё раз|еще раз|что вы сказали|не расслышал)/.test(t)) {
    const last = [...ctx.history].reverse().find((h) => h.role === 'bot');
    return { ctx, say: last ? [last.text] : [], actions: [] };
  }

  // «назад» → предыдущий слот
  if (/(назад|вернуться|вернись|предыдущий вопрос)/.test(t)) {
    return back(ctx);
  }

  // «отмена», «стоп», «не надо» → подтверждение отмены.
  // «отмени запись» — это не прерывание, а отдельный сценарий (перенос/отмена), его ловит интент.
  if (/(стоп|не надо|хватит|отмен)/.test(t) && !/запис/.test(t)) {
    ctx.pending = 'cancel';
    ctx.state = 'CONFIRM';
    ctx.lastAsked = 'CONFIRM';
    return { ctx, say: pick(ctx, R.cancelAsk), actions: [] };
  }

  return null;
}

/** Клиент молчит: 1 — напомнить, 2 — повторить вопрос короче, 3 — вежливо закрыть, слоты сохранить. */
export function onSilence(ctx: Ctx, _ev: BotEvent): StepResult {
  const n = (ctx.retries.SILENCE ?? 0) + 1;
  ctx.retries.SILENCE = n;
  if (n === 1) return { ctx, say: [R.silence[0]], actions: [] };
  if (n === 2) {
    // Повторяем сам вопрос — коротко. Напоминание о молчании за вопрос не считаем.
    const last = [...ctx.history].reverse().find((h) => h.role === 'bot' && !R.silence.includes(h.text));
    return { ctx, say: [last && last.text.length <= 120 ? last.text : R.silence[1]], actions: [] };
  }
  ctx.outcome = 'abandoned';
  return { ctx, say: [R.silence[2]], actions: [] };
}

/**
 * Клиент перебил бота: озвучка останавливается, недосказанное отменяется.
 * Саму реплику клиента машина разбирает как обычный ввод.
 */
export function onBargeIn(ctx: Ctx, _ev: BotEvent): StepResult {
  return { ctx, say: [], actions: [] };
}
