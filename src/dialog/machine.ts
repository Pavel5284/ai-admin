import type { Action, BotEvent, Ctx, StateId, StepResult } from './states';
import { R } from './replies';
import {
  checkGlobalIntents, goto, handoff, misunderstood, onBargeIn, onSilence, pick, say,
} from './policies';
import { formatDate, hasFaqQuestion, matchMaster, serviceTitle, understand, type Nlu } from '../nlu/intent';
import { findFreeSlots, type FreeSlot } from '../services/slots';

type Handler = (ctx: Ctx, nlu: Nlu, now: Date) => StepResult | Promise<StepResult>;

/** Мастера из seed.sql; после подключения БД идентификаторы придут из таблицы masters. */
const MASTER_IDS: Record<string, number> = { 'артем': 1, 'руслан': 2, 'диана': 3 };

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
    return commit(ctx, ev, { ctx: res.ctx, say: [...stopped.say, ...res.say], actions: res.actions }, now);
  }

  // 3. обычный текст: NLU, затем обработчик текущего состояния
  const nlu = await understand(ctx, ev.text, now);

  // Клиент задал вопрос посреди записи — отвечаем и возвращаем его туда, где он был.
  if (nlu.intent === 'faq' && ctx.state !== 'INTENT' && ctx.state !== 'FAQ' && ctx.state !== 'RESUME') {
    ctx.resume = ctx.state;
    return commit(ctx, ev, faqAnswer(ctx), now);
  }

  // Клиент сказал неоднозначно — уточняем, слот при этом не заполняем.
  if (nlu.ambiguous?.length) {
    return commit(ctx, ev, clarify(ctx, nlu), now);
  }

  const res = await handlers[ctx.state](ctx, nlu, now);
  return commit(ctx, ev, res, now);
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
  if (!s.time && !s.timeRange && nlu.time) s.time = nlu.time;
  if (!s.time && !s.timeRange && nlu.timeRange) s.timeRange = nlu.timeRange;
  if (!s.phone && nlu.phone) s.phone = nlu.phone;
  if (!s.name && nlu.name) s.name = nlu.name;
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

/** Подтверждение: услуга, дата словами, время, телефон. */
function confirmAsk(ctx: Ctx, now: Date): StepResult {
  const s = ctx.slots;
  ctx.state = 'CONFIRM';
  ctx.lastAsked = 'CONFIRM';
  ctx.pending = undefined;
  const summary = [
    serviceTitle(s.service) ?? 'услуга',
    s.date ? formatDate(s.date, now) : 'дата не выбрана',
    s.time ?? (s.timeRange ? `${s.timeRange.from}–${s.timeRange.to}` : 'время не выбрано'),
    s.phone ?? 'телефон не указан',
  ].join(', ');
  return { ctx, say: [R.confirm(summary)], actions: [] };
}

/** Показать свободные окна и войти в OFFER_SLOTS. */
function offerSlots(ctx: Ctx, free: FreeSlot[], now: Date): StepResult {
  const list = free.map((s, i) => `${i + 1}) ${s.time}${s.masterName ? ' — ' + s.masterName : ''}`).join(', ');
  const when = ctx.slots.date ? formatDate(ctx.slots.date, now) : 'в этот день';
  return goto(ctx, 'OFFER_SLOTS', [`Свободное время ${when}: ${list}. Какое выбираете?`]);
}

/** Выбор одного из предложенных окон. */
function pickSlot(nlu: Nlu, free: FreeSlot[]): string | undefined {
  const index: Record<string, number> = {
    '1': 0, '2': 1, '3': 2, 'один': 0, 'два': 1, 'три': 2,
    'первый': 0, 'второй': 1, 'третий': 2,
  };
  if (nlu.text in index) return free[index[nlu.text]]?.time;
  if (nlu.time) {
    const found = free.find((s) => s.time === nlu.time);
    if (found) return found.time;
  }
  if (/(любой|любая|все равно|что есть|первый вариант)/.test(nlu.text)) return free[0]?.time;
  return undefined;
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
    const master = matchMaster(nlu.text);
    if (master) ctx.slots.masterId = MASTER_IDS[master];
    return advance(ctx, now);   // если мастер не назван — берём любого свободного
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
    if (nlu.time) {
      ctx.slots.time = nlu.time;
      delete ctx.slots.timeRange;
    } else {
      ctx.slots.timeRange = nlu.timeRange;
    }
    ctx.retries.ASK_TIME = 0;

    const free = await findFreeSlots(ctx.slots.date, ctx.slots.service);
    if (free.length && ctx.slots.time && !free.some((f) => f.time === ctx.slots.time)) {
      return offerSlots(ctx, free, now);   // это время занято — показываем свободные
    }
    return advance(ctx, now);
  },

  OFFER_SLOTS: async (ctx, nlu, now) => {
    absorb(ctx, nlu);
    const free = await findFreeSlots(ctx.slots.date, ctx.slots.service);
    if (!free.length) return goto(ctx, 'ASK_DATE', R.noSlots);
    const chosen = pickSlot(nlu, free);
    if (chosen) {
      ctx.slots.time = chosen;
      delete ctx.slots.timeRange;
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

  RESUME: (ctx, nlu) => {
    const target = ctx.resume ?? 'INTENT';
    delete ctx.resume;
    if (nlu.no) {
      ctx.state = 'DONE';
      return { ctx, say: pick(ctx, R.goodbye), actions: [] };
    }
    return askAgain(ctx, target);
  },

  DONE: (ctx) => ({ ctx, say: [], actions: [] }),
};
