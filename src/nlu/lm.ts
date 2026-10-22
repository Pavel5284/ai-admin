/**
 * LLM в разборе реплики: извлекает, но не решает (день 10 гайда, раздел 3.3).
 *
 * Правила идут первыми и всегда сильнее: модель вызывается, только когда
 * правила не справились (длинная реплика без ожидаемого слота или непонятный
 * интент). Всё, что приносит модель, проходит `verify`: услуга — из БД, дата —
 * реальная и не дальше горизонта, время — в рабочих часах, цифры телефона —
 * из текста клиента. Решения принимает только код.
 */

import { z } from 'zod';
import { complete, tryJson } from '../services/llm';
import { allServices, serviceByCode } from '../services/slots';
import { dateIssue, isoDate } from './dates';
import { toE164 } from './phone';
import { outsideWorkHours } from './time';
import type { Ctx, StateId } from '../dialog/states';
import type { Nlu } from './intent';

const Extraction = z.object({
  intent: z.enum(['book', 'reschedule', 'cancel', 'faq', 'handoff', 'smalltalk', 'unknown']),
  service: z.string().nullable(),                  // только код из списка
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  time: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  phone_digits: z.string().regex(/^\d{0,11}$/).nullable(),
  name: z.string().max(40).nullable(),
  is_correction: z.boolean(),                      // клиент поправляет себя
  confidence: z.number().min(0).max(1),
});

type Extraction = z.infer<typeof Extraction>;

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

/** Какой слот бот сейчас ждёт — это подставляется в промпт динамически. */
const ASKED_SLOT: Partial<Record<StateId, string>> = {
  ASK_SERVICE: 'услуга',
  ASK_DATE: 'дата',
  ASK_TIME: 'время',
  ASK_CONTACT: 'телефон',
};

/** Какие слоты можно уточнять через LLM в каждом состоянии. */
const EXPECTED_SLOT: Partial<Record<StateId, keyof Nlu>> = {
  ASK_SERVICE: 'service',
  ASK_DATE: 'date',
  ASK_TIME: 'time',
  ASK_CONTACT: 'phone',
};

function buildPrompt(ctx: Ctx, now: Date): string {
  const services = allServices().map((s) => `${s.code}: ${s.title}`).join(', ');   // список из БД, не руками
  return [
    'Ты извлекаешь данные из реплики клиента барбершопа. Текст получен распознаванием',
    'речи и может содержать ошибки.',
    `Сегодня: ${isoDate(now)}, ${WEEKDAYS[now.getDay()]}. Часовой пояс: ${process.env.BUSINESS_TZ ?? 'Europe/Moscow'}.`,
    `Допустимые услуги (код: название): ${services}.`,
    `Сейчас бот спрашивает: ${ASKED_SLOT[ctx.state] ?? '—'}.`,
    'Верни ТОЛЬКО JSON ровно с этими полями:',
    '{"intent": "book|reschedule|cancel|faq|handoff|smalltalk|unknown",',
    ' "service": "<код из списка>|null", "date": "ГГГГ-ММ-ДД|null", "time": "ЧЧ:ММ|null",',
    ' "phone_digits": "цифры|null", "name": "имя|null", "is_correction": true|false, "confidence": 0..1}',
    'Схемы не отклоняй и поля не добавляй. Если значения нет в реплике или ты не уверен,',
    'ставь null. Ничего не выдумывай и не угадывай.',
    'Если услуга клиента не входит в список (нет в прайсе и не синоним ей) —',
    'service: null, никогда не выбирай похожую услугу из списка.',
  ].join('\n');
}

/**
 * Нужна ли модель этой реплике: она стоит денег и секунды-две задержки.
 * «Да/нет» и недобранный по частям телефон — всегда зона правил.
 */
function needsLlm(nlu: Nlu, text: string, ctx: Ctx): boolean {
  if (nlu.yes || nlu.no) return false;
  // Недобранный по частям номер — зона правил, но только там, где ждём телефон:
  // в других состояниях случайные цифры («после шести») не должны глушить модель.
  const waitingPhone = ctx.state === 'ASK_CONTACT' || ctx.state === 'FIND_BOOKING';
  if ((nlu.digits || nlu.phoneStatus) && waitingPhone) return false;
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 3) return false;                                   // «хм», номер телефона и т.п. — модели нечего извлекать

  const expected = EXPECTED_SLOT[ctx.state];
  if (expected) {
    if (nlu[expected] !== undefined) return false;               // что спрашивали — нашли
    return words >= 3;                                           // не нашли: просит модель
  }
  return nlu.intent === 'unknown';                               // без ожидания — только когда непонятно о чём речь
}

const INTENT_MAP = {
  book: 'booking', reschedule: 'reschedule', cancel: 'cancel',
  faq: 'faq', handoff: 'handoff', smalltalk: 'unknown', unknown: 'unknown',
} as const;

async function extract(text: string, ctx: Ctx, now: Date): Promise<Extraction | null> {
  for (let attempt = 0; attempt < 2; attempt++) {                // zod-проверка: невалидный JSON дадим модели второй шанс
    try {
      // 1024, а не дефолтные 400: мыслительные модели (gpt-oss, Qwen) тратят
      // бюджет на скрытый reasoning — при 400 ответ обрезается до пустоты.
      const raw = await complete({ system: buildPrompt(ctx, now), user: text, maxTokens: 1024 });
      const parsed = Extraction.safeParse(tryJson(raw));
      if (parsed.success) return parsed.data;
    } catch {
      return null;                                               // LLM недоступен: дальше работают правила
    }
  }
  return null;
}

/**
 * Верификация результата модели. Ничего не попадает в слоты до проверки:
 *   - услуга должна быть из БД;
 *   - дата реальная, не в прошлом и не дальше горизонта (60 дней);
 *   - время в рабочих часах салона;
 *   - цифры телефона обязаны присутствовать в реплике («опора на текст»):
 *     модель не имеет права додумать номер.
 * Правила сильнее модели: заполненные ими слоты LLM не перезаписывает.
 */
function verifyMerge(nlu: Nlu, e: Extraction, text: string, now: Date): Nlu {
  if (e.confidence < 0.5) return nlu;

  const out: Nlu = { ...nlu };

  // Смысл реплики уточняется только если правила его не поняли.
  const intent = INTENT_MAP[e.intent] as Nlu['intent'];
  if (out.intent === 'unknown' && intent !== 'unknown') out.intent = intent;

  if (!out.service && e.service && serviceByCode(e.service)) out.service = e.service;
  if (!out.date && e.date && dateIssue(e.date, now) === null) out.date = e.date;
  if (!out.time && e.time && !outsideWorkHours(e.time)) out.time = e.time;

  // Цифры должны реально быть в тексте клиента: иначе это выдумка модели.
  if (!out.phone && e.phone_digits && e.phone_digits.length >= 10) {
    const digits = text.replace(/\D/g, '');
    if (e.phone_digits.split('').every((d) => digits.includes(d))) {
      out.phone = toE164(e.phone_digits) ?? undefined;
    }
  }

  if (!out.name && e.name && /^[а-я]{2,40}$/.test(e.name)) out.name = e.name;

  // is_correction («клиент поправляет себя») влияет только на то, что
  // правила сильнее модели: исправленные слоты модель не перезаписывает.
  return out;
}

/**
 * Точка входа из `understand`: правила уже отработали, модель пробует
 * добрать то, чего не хватает. Возвращает того же клиента, если модель
 * не нужна, недоступна или её ответ не прошёл проверку.
 */
export async function refineWithLlm(nlu: Nlu, text: string, ctx: Ctx, now: Date): Promise<Nlu> {
  if (!needsLlm(nlu, text, ctx)) return nlu;
  if (!allServices().length) return nlu;                         // каталог не загружен — достраивать нечем
  const e = await extract(text, ctx, now);
  if (!e) return nlu;
  return verifyMerge(nlu, e, text, now);
}
