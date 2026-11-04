import type { BotEvent, Ctx, StateId, StepResult } from './states';
import { R, bookingSummary, variant } from './replies';
import { normalize } from '../nlu/normalize';
import { hasFaqQuestion, isQuestion } from '../nlu/intent';

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

/**
 * Передача администратору: останавливаем запись и просим контакт.
 * Задачу в CRM создаём только после телефона (или явного отказа его оставить),
 * чтобы администратор сразу видел, куда звонить.
 */
export function handoff(
  ctx: Ctx,
  reason: string,
  texts: string[] = R.handoff,
  outcome: Ctx['outcome'] = 'handoff',
): StepResult {
  ctx.state = 'HANDOFF';
  ctx.lastAsked = 'HANDOFF';
  ctx.outcome = outcome;
  ctx.handoffReason = reason;
  delete ctx.resume;
  delete ctx.pending;
  delete ctx.bookingId;
  delete ctx.bookings;
  delete ctx.activeBooking;
  delete ctx.nearest;
  delete ctx.wantsNearest;
  ctx.retries.HANDOFF = 0;
  return {
    ctx,
    say: [...pick(ctx, texts), ...pick(ctx, R.askHandoffContact)],
    actions: [],
    humanize: false,
  };
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
      delete ctx.nearest;
      delete ctx.wantsNearest;
      return goto(ctx, 'ASK_DATE', R.askDate);
    case 'ASK_TIME':
      delete ctx.slots.time;
      delete ctx.slots.timeRange;
      delete ctx.nearest;
      delete ctx.wantsNearest;
      return goto(ctx, 'ASK_TIME', R.askTime);
    case 'ASK_CONTACT':
      delete ctx.slots.phone;
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

  // «повторите» → повтор последней реплики бота. Если бот ещё ничего не
  // говорил, повторять нечего: здороваемся и спрашиваем, что нужно.
  if (/(повтори|ещё раз|еще раз|что вы сказали|не расслышал)/.test(t)) {
    const last = [...ctx.history].reverse().find((h) => h.role === 'bot');
    if (last) return { ctx, say: [last.text], actions: [] };
    if (ctx.state === 'START') {
      const res = goto(ctx, 'INTENT', R.askIntent);
      return { ctx, say: [...pick(ctx, R.greet), ...res.say], actions: [] };
    }
    return say(ctx, R.askIntent);
  }

  // «назад» → предыдущий слот
  if (/(назад|вернуться|вернись|предыдущий вопрос)/.test(t)) {
    return back(ctx);
  }

  // «отмена», «стоп», «не надо» → подтверждение отмены.
  // «За сколько часов можно отменить?» — вопрос о правилах, а не команда.
  const stop = /(стоп|хватит|отмен)/.test(t);
  const notNow = /не\s+надо/.test(t);
  if (!stop && !notNow) return null;

  // Императив «отмените» с вопросительным знаком командой быть не перестаёт.
  const cancelQuestion = hasFaqQuestion(t) && isQuestion(t)
    && !/^\s*(?:а\s+)?отмен(?:и|ите|ить|а|у)?(?:\s+пожалуйста)?\s*\??$/u.test(t);
  if (cancelQuestion) return null;

  // «Не надо» в этих вопросах — ответ по смыслу, а не отмена записи.
  if (notNow && (ctx.state === 'ASK_NAME' || ctx.state === 'ASK_MASTER')) return null;

  // В HANDOFF «не надо» — отказ оставлять телефон.
  if (ctx.state === 'HANDOFF') return null;

  // Явная просьба отменить запись в начале диалога — это отдельный сценарий
  // (найти запись по аккаунту), а не глобальный перехват.
  const explicitCancel = /отмен/.test(t);
  const wantsCancelBooking = explicitCancel && /запис/.test(t);
  if (explicitCancel
    && (ctx.state === 'START' || ctx.state === 'INTENT' || ctx.state === 'FAQ'
      || ctx.state === 'RESUME' || ctx.state === 'DONE')) {
    return null;
  }

  // Пока запись ещё ищем, отменять нечего: пусть FIND_BOOKING разберётся.
  if (ctx.state === 'FIND_BOOKING' && !ctx.bookingId && !ctx.activeBooking) {
    if (explicitCancel) return null;
    // «стоп» в поиске записи — прекращаем поиск, а не подтверждаем отмену.
    ctx.pending = undefined;
    ctx.bookings = undefined;
    return goto(ctx, 'INTENT', R.askIntent);
  }

  // Уже подтверждаем отмену: повторяем вопрос, не сбрасывая найденную запись.
  if (ctx.pending === 'cancel') {
    return { ctx, say: pick(ctx, R.cancelAsk), actions: [] };
  }

  // Клиент явно просит отменить найденную запись — даже если сейчас перенос.
  if (wantsCancelBooking && ctx.activeBooking) {
    ctx.pending = 'cancel';
    ctx.state = 'CONFIRM';
    ctx.lastAsked = 'CONFIRM';
    return { ctx, say: [R.cancelBooking(bookingSummary(ctx.activeBooking))], actions: [] };
  }

  // Перенос: «стоп» прекращает перенос, но не отменяет саму запись.
  if (ctx.pending === 'reschedule') {
    ctx.abortState = ctx.state;
    ctx.pending = 'cancel_reschedule';
    ctx.state = 'CONFIRM';
    ctx.lastAsked = 'CONFIRM';
    return { ctx, say: pick(ctx, R.cancelRescheduleAsk), actions: [] };
  }

  // Обычная запись или пустой диалог: подтверждение отмены.
  ctx.abortState = ctx.state;
  ctx.pending = 'cancel';
  ctx.state = 'CONFIRM';
  ctx.lastAsked = 'CONFIRM';
  return { ctx, say: pick(ctx, R.cancelAsk), actions: [] };
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
  // Закрываем сессию, а не просто помечаем исход: иначе silence-worker будет
  // повторять «Вы здесь?» каждые 15 минут, а вернувшийся клиент попадёт
  // в брошенный диалог вместо нового. Следующая реплика начнёт всё с начала.
  ctx.state = 'DONE';
  ctx.lastAsked = 'DONE';
  return { ctx, say: [R.silence[2]], actions: [] };
}

/**
 * Клиент перебил бота: озвучка останавливается, недосказанное отменяется.
 * Саму реплику клиента машина разбирает как обычный ввод.
 */
export function onBargeIn(ctx: Ctx, _ev: BotEvent): StepResult {
  return { ctx, say: [], actions: [] };
}
