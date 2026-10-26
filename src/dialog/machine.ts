import type { Action, BotEvent, BookingRef, Ctx, StateId, StepResult } from './states';
import { R } from './replies';
import {
  checkGlobalIntents, goto, handoff, misunderstood, onBargeIn, onSilence, pick, say,
} from './policies';
import { formatDate, hasFaqQuestion, looksLikeName, understand, type Nlu } from '../nlu/intent';
import { dateIssue, isoDate } from '../nlu/dates';
import { outsideWorkHours } from '../nlu/time';
import { answerKb } from '../services/kb';
import {
  allMasters, findBookingsByPhone, findSlots, matchMaster, masterById, nearestSlots, serviceTitle,
  type FreeSlot,
} from '../services/slots';

type Handler = (ctx: Ctx, nlu: Nlu, now: Date) => StepResult | Promise<StepResult>;

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

  // Клиент задал вопрос посреди записи — отвечаем из базы знаний и предлагаем продолжить.
  if (nlu.intent === 'faq' && ctx.state !== 'INTENT' && ctx.state !== 'FAQ') {
    // START: бот ещё ничего не спрашивал, возвращаться некуда. RESUME: цель уже сохранена.
    if (ctx.state !== 'START' && ctx.state !== 'RESUME') ctx.resume = ctx.state;
    return commit(ctx, ev, { ...await faqAnswer(ctx, ev.text), nlu }, now);
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
    return commit(ctx, ev, { ...askMaster(ctx), nlu }, now);
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
  // В ASK_CONTACT клиент диктует телефон, а цифры и слова «восемь», «два»
  // парсер дат легко принимает за день месяца. Такой ход не должен
  // перезаписывать уже выбранные услугу, дату и время.
  const phoneTurn = (ctx.state === 'ASK_CONTACT' || ctx.state === 'FIND_BOOKING')
    && (nlu.phone != null || nlu.digits != null || nlu.phoneStatus != null);
  // «Первый», «2», «третий» — это выбор из списка, а не дата. Парсер дат
  // иначе честно увидит в «первый» первое число следующего месяца.
  const choiceTurn = (ctx.state === 'OFFER_SLOTS'
    || (ctx.state === 'FIND_BOOKING' && !!ctx.bookings?.length && !ctx.bookingId))
    && /^(?:[1-3]|один|два|три|перв\p{L}*|втор\p{L}*|трет\p{L}*)$/u.test(nlu.text.trim());
  if (!phoneTurn) {
    // Услуга и дата, как и время, — «последнее сказанное главнее»: клиент может
    // передумать посреди записи («ой нет, лучше в субботу») или поправить слот.
    if (nlu.service) s.service = nlu.service;
    if (nlu.date && !choiceTurn) s.date = nlu.date;
    // Конкретное время заменяет диапазон и наоборот: последнее сказанное — главное.
    if (nlu.time) {
      s.time = nlu.time;
      delete s.timeRange;
    } else if (nlu.timeRange) {
      s.timeRange = nlu.timeRange;
      delete s.time;
    }
    // Мастер — тоже слот: «к Артёму» можно сказать в любой момент диалога.
    if (/(любому|любой|неважно|все равно|кто свободен)/.test(nlu.text)) delete s.masterId;
    else {
      const master = matchMaster(nlu.text);
      if (master) s.masterId = master.id;
    }
  }
  if (!s.phone && nlu.phone) s.phone = nlu.phone;
  if (!s.name && nlu.name) s.name = nlu.name;
}

/** После каждой реплики смотрим, какого слота не хватает, и спрашиваем про первый. */
async function advance(ctx: Ctx, now: Date): Promise<StepResult> {
  const s = ctx.slots;
  if (!s.service) return goto(ctx, 'ASK_SERVICE', R.askService);
  if (!s.date) return goto(ctx, 'ASK_DATE', R.askDate);
  // «Завтра после обеда» — это ещё не конкретное время. Сразу показываем
  // подходящие окна, а не спрашиваем телефон: иначе клиент подтвердит
  // запись, которой нет.
  if (!s.time && s.timeRange) {
    const inRange = await findSlots(s.service, s.date, now, {
      range: s.timeRange, masterId: s.masterId,
    });
    if (inRange.length) return offerSlots(ctx, inRange, now);
    return offerOtherDays(ctx, now);
  }
  if (!s.time) return goto(ctx, 'ASK_TIME', R.askTime);
  if (!s.phone) return goto(ctx, 'ASK_CONTACT', R.askPhone);
  // Имя нужно для записи, но клиент может отказаться: «пропустить» запомним
  // и больше не переспрашиваем. При переносе имя уже есть в записи.
  if (ctx.pending !== 'reschedule' && !s.name && !ctx.nameSkipped) {
    return goto(ctx, 'ASK_NAME', R.askName);
  }
  return confirmAsk(ctx, now);
}

const masterNames = (): string[] => allMasters().map((m) => m.name);

/**
 * Спросить мастера. Если клиент назвал неизвестное имя («Иван»), честно
 * говорим, кого нет, и перечисляем тех, кто есть, — вместо «не понял».
 */
function askMaster(ctx: Ctx, text = ''): StepResult {
  const names = masterNames();
  const unknown = text
    .split(/[^\p{L}-]+/u)
    .find((w) => !/^маст/iu.test(w) && looksLikeName(w));
  return goto(ctx, 'ASK_MASTER', unknown ? R.masterUnknown(unknown, names) : R.askMasterOptions(names));
}

/** Подтверждение: услуга, дата словами, время, мастер, телефон, имя. */
function confirmAsk(ctx: Ctx, now: Date): StepResult {
  const s = ctx.slots;
  ctx.state = 'CONFIRM';
  ctx.lastAsked = 'CONFIRM';
  const master = s.masterId ? masterById(s.masterId)?.name : undefined;
  const summary = [
    serviceTitle(s.service) ?? 'услуга',
    s.date ? formatDate(s.date, now) : 'дата не выбрана',
    s.time ?? (s.timeRange ? `${s.timeRange.from}–${s.timeRange.to}` : 'время не выбрано'),
    master ? `мастер ${master}` : 'мастер на выбор',
    s.phone ?? 'телефон не указан',
    ...(s.name ? [`имя ${s.name}`] : []),
  ].join(', ');
  // При переносе мы не «записываем», а меняем время — формулировка другая.
  if (ctx.pending === 'reschedule') {
    return { ctx, say: [R.confirmReschedule(summary)], actions: [] };
  }
  ctx.pending = undefined;
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

/** Выбор одной из нескольких найденных записей. */
function pickBooking<T extends { id: number; time: string }>(
  nlu: Nlu,
  bookings: T[],
): T | undefined {
  const index: Record<string, number> = {
    '1': 0, '2': 1, '3': 2, 'один': 0, 'два': 1, 'три': 2,
    'первая': 0, 'вторая': 1, 'третья': 2, 'первый': 0, 'второй': 1, 'третий': 2,
  };
  if (nlu.text in index) return bookings[index[nlu.text]];
  if (nlu.time) {
    const byTime = bookings.find((b) => b.time === nlu.time);
    if (byTime) return byTime;
  }
  return undefined;
}

/** Запись найдена: дальше — отмена или перенос. */
function afterBookingFound(ctx: Ctx, booking: BookingRef): StepResult {
  if (ctx.pending === 'reschedule') {
    // Перенос: та же услуга и мастер, новая дата и время.
    ctx.slots.service = booking.serviceCode;
    ctx.slots.masterId = booking.masterId;
    delete ctx.slots.date;
    delete ctx.slots.time;
    delete ctx.slots.timeRange;
    return goto(ctx, 'ASK_DATE', R.askDate);
  }
  // Отмена: показываем, что именно отменяем, и просим подтвердить.
  ctx.state = 'CONFIRM';
  ctx.lastAsked = 'CONFIRM';
  const summary = `${booking.serviceTitle}, ${booking.date} ${booking.time}, мастер ${booking.masterName}`;
  return { ctx, say: [R.cancelBooking(summary)], actions: [] };
}

/** Чистим слоты записи — например, когда по телефону ничего не нашли. */
function clearBookingSlots(ctx: Ctx): void {
  delete ctx.slots.service;
  delete ctx.slots.date;
  delete ctx.slots.time;
  delete ctx.slots.timeRange;
}

/**
 * Нужный день занят: показываем ближайшие дни со свободными окнами
 * и просим назвать другой день (строка «Нет свободных слотов» в таблице нештатных ситуаций).
 */
async function offerOtherDays(ctx: Ctx, now: Date): Promise<StepResult> {
  const from = ctx.slots.date ?? isoDate(now);
  const near = await nearestSlots(ctx.slots.service, from, now);
  if (!near.length) return goto(ctx, 'ASK_DATE', R.noSlots);
  const list = near
    .map((d) => `${formatDate(d.date, now)} — ${d.slots.map((s) => s.time).join(', ')}`)
    .join('; ');
  return goto(ctx, 'ASK_DATE', [`${R.noSlots[0]} Ближайшие окна: ${list}. На какой день перенесём?`]);
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
    case 'ASK_NAME': return goto(ctx, state, R.askName);
    default: return goto(ctx, 'INTENT', R.askIntent);
  }
}

/**
 * Ответ на вопрос клиента по базе знаний (день 12–13).
 * Есть ответ в базе — отвечаем фрагментами, защитных выдумок в ответе нет:
 * `answerKb` проверяет порог, схему и числа. Ответа нет — честное «уточню у
 * администратора» и задача оператору. Если клиент отвлёкся вопросом посреди
 * записи — предлагаем продолжить.
 */
async function faqAnswer(ctx: Ctx, question: string): Promise<StepResult> {
  const kb = await answerKb(question).catch(() => ({ answerable: false, answer: '', best: null }));

  if (kb.answerable && kb.answer) {
    ctx.outcome = 'faq_answered';
    if (ctx.resume) {                      // вопрос посреди записи: возвращаемся к прерванному
      ctx.state = 'RESUME';
      ctx.lastAsked = 'RESUME';
      return { ctx, say: [kb.answer, ...pick(ctx, R.continueBooking)], actions: [] };
    }
    ctx.state = 'FAQ';                     // ответили в начале диалога: слушаем дальше сами
    ctx.lastAsked = 'FAQ';
    ctx.retries.FAQ = 0;
    return { ctx, say: [kb.answer, ...pick(ctx, R.afterFaq)], actions: [] };
  }

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
    // Даже если смысл реплики не понят, названные дату/время/услугу не теряем:
    // «мне бы завтра после обеда» — это уже полезные слоты для следующего шага.
    absorb(ctx, nlu);
    if (nlu.intent === 'unknown') return { ctx, say: hello, actions: [] };
    const res = await handlers.INTENT(ctx, nlu, now);
    return { ctx: res.ctx, say: [...hello, ...res.say], actions: res.actions };
  },

  INTENT: async (ctx, nlu, now) => {
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
      return faqAnswer(ctx, nlu.text);
    }
    if (nlu.intent === 'faq') return faqAnswer(ctx, nlu.text);
    if (nlu.intent === 'booking') return advance(ctx, now);
    return misunderstood(ctx, 'INTENT');
  },

  ASK_SERVICE: async (ctx, nlu, now) => {
    absorb(ctx, nlu);
    if (nlu.service) {
      ctx.slots.service = nlu.service;
      ctx.retries.ASK_SERVICE = 0;
      return advance(ctx, now);
    }
    if (nlu.date || nlu.time || nlu.phone) return goto(ctx, 'ASK_SERVICE', R.askService);
    return misunderstood(ctx, 'ASK_SERVICE');
  },

  ASK_MASTER: async (ctx, nlu, now) => {
    absorb(ctx, nlu);              // названного мастера absorb уже записал
    // «Любой», «неважно», «нет» — мастер не нужен, идём дальше.
    if (nlu.no || /(любой|любая|любого|любому|любую|неважно|все равно|кто свободен|кто угодно|без разницы)/.test(nlu.text)) {
      delete ctx.slots.masterId;
      ctx.retries.ASK_MASTER = 0;
      return advance(ctx, now);
    }
    if (ctx.slots.masterId) {
      ctx.retries.ASK_MASTER = 0;
      return advance(ctx, now);
    }
    // Названо имя, которого нет в списке, — показываем, кто есть.
    if (/(мастер|специалист|барбер)/.test(nlu.text) || looksLikeName(nlu.text)) {
      return askMaster(ctx, nlu.text);
    }
    return misunderstood(ctx, 'ASK_MASTER');
  },

  ASK_DATE: async (ctx, nlu, now) => {
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

    // Время-диапазон («после обеда»): ищем окна внутри диапазона.
    if (!ctx.slots.time && ctx.slots.timeRange) {
      const inRange = await findSlots(ctx.slots.service, ctx.slots.date, now, {
        range: ctx.slots.timeRange, masterId: ctx.slots.masterId,
      });
      if (inRange.length) return offerSlots(ctx, inRange, now);
      return offerOtherDays(ctx, now);
    }

    const free = await findSlots(ctx.slots.service, ctx.slots.date, now, {
      masterId: ctx.slots.masterId,
    });
    if (!free.length) return offerOtherDays(ctx, now);
    if (ctx.slots.time && !free.some((f) => f.time === ctx.slots.time)) {
      return offerSlots(ctx, free, now);   // это время занято — показываем свободные
    }
    return advance(ctx, now);
  },

  OFFER_SLOTS: async (ctx, nlu, now) => {
    absorb(ctx, nlu);
    const free = await findSlots(ctx.slots.service, ctx.slots.date, now, {
      range: ctx.slots.timeRange, masterId: ctx.slots.masterId,
    });
    if (!free.length) return offerOtherDays(ctx, now);
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

  ASK_CONTACT: async (ctx, nlu, now) => {
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

  ASK_NAME: async (ctx, nlu, now) => {
    absorb(ctx, nlu);
    if (nlu.name) {
      ctx.slots.name = nlu.name;
      delete ctx.nameSkipped;
      ctx.retries.ASK_NAME = 0;
      return advance(ctx, now);
    }
    // Имя необязательно: «пропустить» или «нет» не должны запирать диалог.
    if (nlu.no || /(пропустить|без имени|не важно|неважно|не надо)/.test(nlu.text)) {
      ctx.nameSkipped = true;
      ctx.retries.ASK_NAME = 0;
      return advance(ctx, now);
    }
    if (nlu.yes) return say(ctx, R.askName);
    const name = looksLikeName(nlu.text);
    if (name) {
      ctx.slots.name = name;
      delete ctx.nameSkipped;
      ctx.retries.ASK_NAME = 0;
      return advance(ctx, now);
    }
    return misunderstood(ctx, 'ASK_NAME');
  },

  CONFIRM: async (ctx, nlu, now) => {
    const master = matchMaster(nlu.text);
    const wantsMaster = /(маст|специалист|барбер)/.test(nlu.text);
    const bareName = !ctx.slots.name && !nlu.yes && !nlu.no ? looksLikeName(nlu.text) : undefined;

    // «что изменить» — клиент называет, какой слот поправить
    if (ctx.pending === 'change') {
      if (nlu.name) {
        ctx.slots.name = nlu.name;
        delete ctx.nameSkipped;
        return confirmAsk(ctx, now);
      }
      // Мастер — такой же слот, как дата и время (D-021): его меняют
      // и словом «мастер», и просто именем («нет, к Артёму»).
      if (wantsMaster || master) {
        if (master) {
          ctx.slots.masterId = master.id;
          return confirmAsk(ctx, now);
        }
        delete ctx.slots.masterId;
        return askMaster(ctx, nlu.text);
      }
      if (/(имя|зовут)/.test(nlu.text)) {
        delete ctx.slots.name;
        delete ctx.nameSkipped;
        return goto(ctx, 'ASK_NAME', R.askName);
      }
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
      if (bareName) {
        ctx.slots.name = bareName;
        delete ctx.nameSkipped;
        return confirmAsk(ctx, now);
      }
      return misunderstood(ctx, 'CONFIRM');
    }

    // подтверждение отмены
    if (ctx.pending === 'cancel') {
      if (nlu.yes) {
        const actions: Action[] = ctx.bookingId
          ? [{ type: 'cancel_booking', id: ctx.bookingId }]
          : [];
        ctx.slots = {};
        ctx.pending = undefined;
        ctx.bookingId = undefined;
        ctx.bookings = undefined;
        ctx.outcome = 'cancelled';
        ctx.state = 'DONE';
        return { ctx, say: pick(ctx, R.cancelled), actions };
      }
      if (nlu.no) {
        ctx.pending = undefined;
        return advance(ctx, now);
      }
      return misunderstood(ctx, 'CONFIRM');
    }

    // подтверждение переноса
    if (ctx.pending === 'reschedule' && ctx.bookingId) {
      if (nlu.yes) {
        const actions: Action[] = [{
          type: 'reschedule_booking',
          id: ctx.bookingId,
          date: ctx.slots.date ?? '',
          time: ctx.slots.time ?? '',
        }];
        // bookingId и pending остаются до успешного ответа CRM/БД: если слот
        // заняли в последнюю секунду, executeActions вернёт нас в OFFER_SLOTS
        // и сможет повторить перенос той же записи.
        ctx.outcome = 'rescheduled';
        ctx.state = 'DONE';
        return { ctx, say: pick(ctx, R.rescheduled), actions };
      }
      if (nlu.no) {
        return goto(ctx, 'ASK_DATE', R.askDate);   // на какую дату переносим
      }
      return misunderstood(ctx, 'CONFIRM');
    }

    // Мастера и имя можно назвать прямо в подтверждении, не переходя
    // в «что изменить»: «хочу мастера Ивана», «меня зовут Иван».
    if (nlu.name) {
      ctx.slots.name = nlu.name;
      delete ctx.nameSkipped;
      return confirmAsk(ctx, now);
    }
    if (master) {
      ctx.slots.masterId = master.id;
      return confirmAsk(ctx, now);
    }
    if (wantsMaster) {
      delete ctx.slots.masterId;
      return askMaster(ctx, nlu.text);
    }
    if (bareName) {
      ctx.slots.name = bareName;
      delete ctx.nameSkipped;
      return confirmAsk(ctx, now);
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

  FIND_BOOKING: async (ctx, nlu, _now) => {
    absorb(ctx, nlu);

    // Клиент выбирает одну из нескольких найденных записей.
    if (ctx.bookings?.length && !ctx.bookingId) {
      const chosen = pickBooking(nlu, ctx.bookings);
      if (!chosen) return misunderstood(ctx, 'FIND_BOOKING');
      ctx.bookingId = chosen.id;
      ctx.bookings = undefined;
      return afterBookingFound(ctx, chosen);
    }

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

    const bookings = await findBookingsByPhone(ctx.slots.phone);
    if (!bookings.length) {
      // Записей нет — предложим записаться заново.
      clearBookingSlots(ctx);
      return goto(ctx, 'ASK_SERVICE', R.notFoundBooking);
    }
    if (bookings.length > 1) {
      ctx.bookings = bookings;
      const list = bookings
        .map((b, i) => `${i + 1}) ${b.serviceTitle}, ${b.date} ${b.time}`)
        .join(', ');
      return goto(ctx, 'FIND_BOOKING', [`Нашёл несколько записей: ${list}. Какую переносим или отменяем?`]);
    }
    ctx.bookingId = bookings[0].id;
    return afterBookingFound(ctx, bookings[0]);
  },

  /**
   * Разговор после ответа из базы знаний. Обычные просьбы ведут себя как в
   * INTENT, вопрос — снова через базу знаний, вежливый «нет» завершает диалог.
   */
  FAQ: async (ctx, nlu, now) => {
    if (nlu.no) {
      ctx.state = 'DONE';
      return { ctx, say: pick(ctx, R.goodbye), actions: [] };
    }
    if (nlu.yes) return advance(ctx, now);      // «да, запишите» — начинаем запись с услуги
    if (nlu.intent === 'faq') return faqAnswer(ctx, nlu.text);
    return handlers.INTENT(ctx, nlu, now);      // «запишите», «перенесите» — как обычный интент
  },

  HANDOFF: (ctx) => {
    const already = ctx.outcome === 'handoff' || ctx.outcome === 'faq_declined';
    if (!already) ctx.outcome = 'handoff';
    ctx.state = 'DONE';
    const actions: Action[] = already ? [] : [{ type: 'handoff', reason: 'handoff' }];
    return { ctx, say: [], actions };
  },

  RESUME: async (ctx, nlu, now) => {
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
