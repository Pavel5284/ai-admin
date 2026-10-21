import type { Action, BotEvent, Ctx, StateId, StepResult } from './states';
import { R } from './replies';
import {
  checkGlobalIntents, goto, handoff, misunderstood, onBargeIn, onSilence, pick, say,
} from './policies';
import { formatDate, hasFaqQuestion, matchMaster, serviceTitle, understand, type Nlu } from '../nlu/intent';
import { dateIssue } from '../nlu/dates';
import { findFreeSlots, type FreeSlot } from '../services/slots';

type Handler = (ctx: Ctx, nlu: Nlu, now: Date) => StepResult | Promise<StepResult>;

/** Мастера из seed.sql; после подключения БД идентификаторы придут из таблицы masters. */
const MASTER_IDS: Record<string, number> = { 'артем': 1, 'руслан': 2, 'диана': 3 };
const MASTER_NAMES: Record<number, string> = { 1: 'Артём', 2: 'Руслан', 3: 'Диана' };

export async function step(ctx: Ctx, ev: BotEvent, now: Date): Promise<StepResult> {
  ctx.lastActivityAt = now.getTime();

  // 1. глобальные перехваты: работают в любом состоянии
  const global = checkGlobalIntents(ctx, ev);
  if (global) return commit(ctx, ev, global, now);

  // 2. события, которые не являются текстом
  if (ev.type === 'silence') return commit(ctx, ev, onSilence(ctx, ev), now);
  if (ev.type === 'non_text') {
    return commit(ctx, ev, say(ctx, R.nonText), now);   // голос, фото, стикер
  }
  if (ev.type === 'barge_in') {
    const stopped = onBargeIn(ctx, ev);        // бот замолкает, недосказанное отменяется
    const nlu = await understand(ctx, ev.text, now);
    const res = await handlers[ctx.state](ctx, nlu, now);
    return commit(ctx, ev, { ctx: res.ctx, say: [...stopped.say, ...res.say], actions: res.actions, nlu }, now);
  }

  // 3. обычный текст: NLU, затем обработчик текущего состояния
  const nlu = await understand(ctx, ev.text, now);

  // Клиент задал вопрос посреди записи — отвечаем и возвращаем его туда, где он был.
  if (nlu.intent === 'faq' && ctx.state !== 'INTENT' && ctx.state !== 'FAQ' && ctx.state !== 'RESUME') {
    ctx.resume = ctx.state;
    return commit(ctx, ev, { ...faqAnswer(ctx), nlu }, now);
  }

  // Дата вне горизонта записи: слот не заполняем, а уточняем у клиента.
  const issue = nlu.date ? dateIssue(nlu.date, now) : null;
  if (issue) {
    return commit(ctx, ev, { ...say(ctx, issue === 'past' ? R.dateInPast : R.dateTooFar), nlu }, now);
  }

  // Время вне часов работы салона: сообщаем график, слот не заполняем (D-007).
  if (nlu.time && outsideWorkHours(nlu.time)) {
    return commit(ctx, ev, { ...say(ctx, R.outsideHours), nlu }, now);
  }

  // Клиент сам спрашивает, к кому идти: спрашиваем мастера отдельным состоянием.
  if (/к\s+кому|к\s+какому\s+мастеру|к\s+мастеру|кому\s+запис/.test(nlu.text)) {
    return commit(ctx, ev, { ...goto(ctx, 'ASK_MASTER', R.askMaster), nlu }, now);
  }

  // Клиент сказал неоднозначно — уточняем, слот при этом не заполняем.
  if (nlu.ambiguous?.length) {
    return commit(ctx, ev, { ...clarify(ctx, nlu), nlu }, now);
  }

  const res = await handlers[ctx.state](ctx, nlu, now);
  return commit(ctx, ev, { ...res, nlu }, now);
}

/** Реплика клиента и ответы бота попадают в историю сессии. */
function commit(ctx: Ctx, ev: BotEvent, res: StepResult, now: Date): StepResult {
  const at = now.getTime();
  if (ev.type === 'user_text' || ev.type === 'barge_in') {
    ctx.history.push({ role: 'user', text: ev.text, at });
  }
  for (const text of res.say) ctx.history.push({ role: 'bot', text, at });
  return res;
}

/** Попутно принимаем слоты, о которых клиент заговорил про запрошенный. */
function absorb(ctx: Ctx, nlu: Nlu): void {
  const s = ctx.slots;
  if (!s.service && nlu.service) s.service = nlu.service;
  if (!s.date && nlu.date) s.date = nlu.date;
  // Конкретное время заменяет диапазон и наоборот: последнее сказанное — главное.
  if (nlu.time) {
    s.time = nlu.time;
    delete s.timeRange;
  } else if (nlu.timeRange) {
    s.timeRange = nlu.timeRange;
    delete s.time;
  }
  if (!s.phone && nlu.phone) s.phone = nlu.phone;
  if (!s.name && nlu.name) s.name = nlu.name;
  // Мастер — тоже слот: «к Артёму» можно сказать в любой момент диалога.
  if (/(любому|любой|неважно|все равно|кто свободен)/.test(nlu.text)) delete s.masterId;
  else {
    const master = matchMaster(nlu.text);
    if (master) s.masterId = MASTER_IDS[master];
  }
}

/** После каждой реплики смотрим, какого слота не хватает, и спрашиваем про первый. */
function advance(ctx: Ctx, now: Date): StepResult {
  const s = ctx.slots;
  if (!s.service) return goto(ctx, 'ASK_SERVICE', R.askService);
  if (!s.date) return goto(ctx, 'ASK_DATE', R.askDate);
  if (!s.time && !s.timeRange) return goto(ctx, 'ASK_TIME', R.askTime);
  if (!s.phone) return goto(ctx, 'ASK_CONTACT', R.askPhone);
  return confirmAsk(ctx, now);
}

/** Подтверждение: услуга, дата словами, время, мастер, телефон. */
function confirmAsk(ctx: Ctx, now: Date): StepResult {
  const s = ctx.slots;
  ctx.state = 'CONFIRM';
  ctx.lastAsked = 'CONFIRM';
  ctx.pending = undefined;
  const master = s.masterId ? MASTER_NAMES[s.masterId] : undefined;
  const summary = [
    serviceTitle(s.service) ?? 'услуга',
    s.date ? formatDate(s.date, now) : 'дата не выбрана',
    s.time ?? (s.timeRange ? `${s.timeRange.from}–${s.timeRange.to}` : 'время не выбрано'),
    master ? `мастер ${master}` : 'мастер на выбор',
    s.phone ?? 'телефон не указан',
  ].join(', ');
  return { ctx, say: [R.confirm(summary)], actions: [] };
}

/** Показать свободные окна и войти в OFFER_SLOTS. Показываем не больше трёх. */
function offerSlots(ctx: Ctx, free: FreeSlot[], now: Date, prefix?: string): StepResult {
  const list = free.slice(0, 3).map((s, i) => `${i + 1}) ${s.time}${s.masterName ? ' — ' + s.masterName : ''}`).join(', ');
  const when = ctx.slots.date ? formatDate(ctx.slots.date, now) : 'в этот день';
  const head = prefix ? prefix + ' ' : '';
  return goto(ctx, 'OFFER_SLOTS', [`${head}Свободное время ${when}: ${list}. Какое выбираете?`]);
}

/** Выбор одного из предложенных окон. */
function pickSlot(nlu: Nlu, free: FreeSlot[]): FreeSlot | undefined {
  const index: Record<string, number> = {
    '1': 0, '2': 1, '3': 2, 'один': 0, 'два': 1, 'три': 2,
    'первый': 0, 'второй': 1, 'третий': 2,
  };
  if (nlu.text in index) return free[index[nlu.text]];
  if (nlu.time) {
    const found = free.find((s) => s.time === nlu.time);
    if (found) return found;
  }
  if (/(любой|любая|все равно|что есть|первый вариант)/.test(nlu.text)) return free[0];
  return undefined;
}

/** Окна только у выбранного мастера, если клиент его назвал. */
function forMaster(free: FreeSlot[], masterId?: number): FreeSlot[] {
  return masterId ? free.filter((f) => f.masterId === masterId) : free;
}

/** Окно попадает в диапазон «после обеда», «вечером» и т. п. */
function inRange(time: string, range: { from: string; to: string }): boolean {
  return time >= range.from && time < range.to;
}

/** Время вне часов работы салона: 10:00–21:00 (D-007). */
function outsideWorkHours(time: string): boolean {
  return time < '10:00' || time > '21:00';
}

/** Клиент сказал неоднозначно — уточняем, слот не заполняем. */
function clarify(ctx: Ctx, nlu: Nlu): StepResult {
  return say(ctx, nlu.ambiguous?.includes('time') ? R.clarifyTime : R.clarifyDate);
}

/** Повторяем вопрос того состояния, из которого клиент отвлёкся вопросом. */
function askAgain(ctx: Ctx, state: StateId): StepResult {
  switch (state) {
    case 'ASK_SERVICE': return goto(ctx, state, R.askService);
    case 'ASK_MASTER': return goto(ctx, state, R.askMaster);
    case 'ASK_DATE': return goto(ctx, state, R.askDate);
    case 'ASK_TIME': return goto(ctx, state, R.askTime);
    case 'ASK_CONTACT': return goto(ctx, state, R.askPhone);
    default: return goto(ctx, 'INTENT', R.askIntent);
  }
}

/**
 * Ответ на вопрос клиента.
 * Заглушка до дня 12: базы знаний ещё нет, поэтому ответа не будет.
 * Если клиент отвлёкся вопросом посреди записи — предлагаем продолжить.
 */
function faqAnswer(ctx: Ctx): StepResult {
  ctx.outcome = 'faq_declined';
  const actions: Action[] = [{ type: 'handoff', reason: 'faq_not_found' }];

  if (ctx.resume) {
    ctx.state = 'RESUME';
    ctx.lastAsked = 'RESUME';
    return { ctx, say: [...pick(ctx, R.noAnswer), ...pick(ctx, R.continueBooking)], actions };
  }
  ctx.state = 'HANDOFF';
  ctx.lastAsked = 'HANDOFF';
  return { ctx, say: pick(ctx, R.noAnswer), actions };
}

const handlers: Record<StateId, Handler> = {
  START: async (ctx, nlu, now) => {
    const hello = pick(ctx, R.greet);
    ctx.state = 'INTENT';
    ctx.lastAsked = 'INTENT';
    if (nlu.intent === 'unknown') return { ctx, say: hello, actions: [] };
    const res = await handlers.INTENT(ctx, nlu, now);
    return { ctx: res.ctx, say: [...hello, ...res.say], actions: res.actions };
  },

  INTENT: (ctx, nlu, now) => {
    absorb(ctx, nlu);
    if (nlu.intent === 'handoff') return handoff(ctx, 'client_asked_operator');
    if (nlu.intent === 'reschedule') {
      ctx.pending = 'reschedule';
      return goto(ctx, 'FIND_BOOKING', R.askPhone);
    }
    if (nlu.intent === 'cancel') {
      ctx.pending = 'cancel';
      return goto(ctx, 'FIND_BOOKING', R.askPhone);
    }
    // Две просьбы в одной реплике: сначала вопрос, потом запись.
    if (nlu.intent === 'booking' && hasFaqQuestion(nlu.text)) {
      ctx.resume = 'INTENT';
      return faqAnswer(ctx);
    }
    if (nlu.intent === 'faq') return faqAnswer(ctx);
    if (nlu.intent === 'booking') return advance(ctx, now);
    return misunderstood(ctx, 'INTENT');
  },

  ASK_SERVICE: (ctx, nlu, now) => {
    absorb(ctx, nlu);
    if (nlu.service) {
      ctx.slots.service = nlu.service;
      ctx.retries.ASK_SERVICE = 0;
      return advance(ctx, now);
    }
    if (nlu.date || nlu.time || nlu.phone) return goto(ctx, 'ASK_SERVICE', R.askService);
    return misunderstood(ctx, 'ASK_SERVICE');
  },

  ASK_MASTER: (ctx, nlu, now) => {
    absorb(ctx, nlu);              // названного мастера absorb уже записал
    return advance(ctx, now);      // если мастер не назван — берём любого свободного
  },

  ASK_DATE: (ctx, nlu, now) => {
    absorb(ctx, nlu);
    if (nlu.date) {
      ctx.slots.date = nlu.date;
      ctx.retries.ASK_DATE = 0;
      return advance(ctx, now);
    }
    if (nlu.service || nlu.time || nlu.timeRange || nlu.phone) return goto(ctx, 'ASK_DATE', R.askDate);
    return misunderstood(ctx, 'ASK_DATE');
  },

  ASK_TIME: async (ctx, nlu, now) => {
    absorb(ctx, nlu);
    if (!nlu.time && !nlu.timeRange) {
      if (nlu.service || nlu.date || nlu.phone) return goto(ctx, 'ASK_TIME', R.askTime);
      return misunderstood(ctx, 'ASK_TIME');
    }
    ctx.retries.ASK_TIME = 0;

    const free = forMaster(await findFreeSlots(ctx.slots.date, ctx.slots.service), ctx.slots.masterId);
    if (!free.length) return goto(ctx, 'ASK_DATE', R.noSlots);

    // Время-диапазон («после обеда»): конкретное окно выбираем из свободных.
    if (!ctx.slots.time && ctx.slots.timeRange) {
      const inRangeSlots = free.filter((f) => inRange(f.time, ctx.slots.timeRange!));
      if (inRangeSlots.length) return offerSlots(ctx, inRangeSlots, now);
      return offerSlots(ctx, free, now, R.rangeBusy[0]);
    }

    if (ctx.slots.time && !free.some((f) => f.time === ctx.slots.time)) {
      return offerSlots(ctx, free, now);   // это время занято — показываем свободные
    }
    return advance(ctx, now);
  },

  OFFER_SLOTS: async (ctx, nlu, now) => {
    absorb(ctx, nlu);
    const free = forMaster(await findFreeSlots(ctx.slots.date, ctx.slots.service), ctx.slots.masterId);
    if (!free.length) return goto(ctx, 'ASK_DATE', R.noSlots);
    const chosen = pickSlot(nlu, free);
    if (chosen) {
      ctx.slots.time = chosen.time;
      delete ctx.slots.timeRange;
      if (chosen.masterId && !ctx.slots.masterId) ctx.slots.masterId = chosen.masterId;
      ctx.retries.OFFER_SLOTS = 0;
      return advance(ctx, now);
    }
    return offerSlots(ctx, free, now);
  },

  ASK_CONTACT: (ctx, nlu, now) => {
    absorb(ctx, nlu);
    if (nlu.phone) {
      ctx.slots.phone = nlu.phone;
      delete ctx.slots.phoneDraft;
      ctx.retries.ASK_CONTACT = 0;
      return advance(ctx, now);
    }
    if (nlu.phoneStatus === 'too_long') {
      delete ctx.slots.phoneDraft;
      return say(ctx, R.phoneTooLong);
    }
    if (nlu.digits) {
      // nlu.digits уже включает накопленные цифры — просто сохраняем.
      ctx.slots.phoneDraft = nlu.digits;
      return say(ctx, [R.phonePartial(nlu.digits.length)]);
    }
    if (nlu.service || nlu.date || nlu.time) return goto(ctx, 'ASK_CONTACT', R.askPhone);
    return misunderstood(ctx, 'ASK_CONTACT');
  },

  CONFIRM: (ctx, nlu, now) => {
    // «что изменить» — клиент называет, какой слот поправить
    if (ctx.pending === 'change') {
      if (/(услуг)/.test(nlu.text)) {
        delete ctx.slots.service;
        return goto(ctx, 'ASK_SERVICE', R.askService);
      }
      if (/(дат|день)/.test(nlu.text)) {
        delete ctx.slots.date;
        return goto(ctx, 'ASK_DATE', R.askDate);
      }
      if (/(врем|час)/.test(nlu.text)) {
        delete ctx.slots.time;
        delete ctx.slots.timeRange;
        return goto(ctx, 'ASK_TIME', R.askTime);
      }
      if (/(телефон|номер)/.test(nlu.text)) {
        delete ctx.slots.phone;
        return goto(ctx, 'ASK_CONTACT', R.askPhone);
      }
      return misunderstood(ctx, 'CONFIRM');
    }

    // подтверждение отмены
    if (ctx.pending === 'cancel') {
      if (nlu.yes) {
        ctx.slots = {};
        ctx.pending = undefined;
        ctx.outcome = 'cancelled';
        ctx.state = 'DONE';
        return { ctx, say: pick(ctx, R.cancelled), actions: [] };
      }
      if (nlu.no) {
        ctx.pending = undefined;
        return advance(ctx, now);
      }
      return misunderstood(ctx, 'CONFIRM');
    }

    if (nlu.yes) {
      ctx.state = 'DONE';
      ctx.outcome = 'booked';
      const slots = { ...ctx.slots };
      const actions: Action[] = [{ type: 'create_booking', slots }];
      return { ctx, say: pick(ctx, R.booked), actions };
    }

    if (nlu.no) {
      ctx.pending = 'change';
      return { ctx, say: pick(ctx, R.whatToChange), actions: [] };
    }

    return misunderstood(ctx, 'CONFIRM');
  },

  FIND_BOOKING: (ctx, nlu) => {
    absorb(ctx, nlu);
    if (!ctx.slots.phone) {
      if (nlu.phoneStatus === 'too_long') {
        delete ctx.slots.phoneDraft;
        return say(ctx, R.phoneTooLong);
      }
      if (nlu.digits) {
        ctx.slots.phoneDraft = nlu.digits;
        return say(ctx, [R.phonePartial(nlu.digits.length)]);
      }
      return goto(ctx, 'FIND_BOOKING', R.askPhone);
    }
    // Заглушка до дня 8: поиск записей в БД появится вместе со слотами.
    delete ctx.slots.service;
    delete ctx.slots.date;
    delete ctx.slots.time;
    delete ctx.slots.timeRange;
    return goto(ctx, 'ASK_SERVICE', [
      'Не нашёл запись на этот номер. Давайте запишем заново — на какую услугу?',
    ]);
  },

  FAQ: (ctx) => faqAnswer(ctx),

  HANDOFF: (ctx) => {
    const already = ctx.outcome === 'handoff' || ctx.outcome === 'faq_declined';
    if (!already) ctx.outcome = 'handoff';
    ctx.state = 'DONE';
    const actions: Action[] = already ? [] : [{ type: 'handoff', reason: 'handoff' }];
    return { ctx, say: [], actions };
  },

  RESUME: (ctx, nlu, now) => {
    const target = ctx.resume ?? 'INTENT';
    delete ctx.resume;
    if (nlu.no) {
      ctx.state = 'DONE';
      return { ctx, say: pick(ctx, R.goodbye), actions: [] };
    }
    // Запись уже начата (услуга названа) — продолжаем её, а не спрашиваем интент заново.
    if (target === 'INTENT' && ctx.slots.service) return advance(ctx, now);
    return askAgain(ctx, target);
  },

  DONE: (ctx) => ({ ctx, say: [], actions: [] }),
};
