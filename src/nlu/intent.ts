import type { Ctx } from '../dialog/states';
import { normalize } from './normalize';
import { parseWhen } from './dates';
import { parseBareHour, parseBareHourInText } from './time';
import { parsePhone } from './phone';
import { matchMaster, matchService } from '../services/slots';
import { refineWithLlm } from './lm';
import { detectSmalltalk, type SmalltalkKind } from './smalltalk';

/**
 * Разбор реплики: интент и слоты.
 * Нормализация, числительные, даты и время живут в соседних модулях
 * (normalize.ts, numbers.ts, dates.ts, time.ts) — здесь только то, что нужно автомату.
 */

export type NluIntent = 'booking' | 'reschedule' | 'cancel' | 'faq' | 'handoff' | 'smalltalk' | 'unknown';

export type Nlu = {
  intent: NluIntent;
  /** Тип светской реплики: нужен для ответа и возврата к текущему вопросу. */
  smalltalk?: SmalltalkKind;
  service?: string;                             // код услуги
  date?: string;                                // 'YYYY-MM-DD'
  time?: string;                                // 'HH:mm'
  timeRange?: { from: string; to: string };
  phone?: string;                               // '+79161234567'
  digits?: string;                              // сырые цифры, если номер неполный
  name?: string;
  yes?: boolean;
  no?: boolean;
  text: string;                                 // нормализованный текст реплики
  ambiguous?: string[];                     // что нужно уточнить у клиента
  phoneStatus?: 'ok' | 'partial' | 'too_long';  // что с номером: готов / копим / заново
};

/**
 * Словарь услуг и имена мастеров живут в БД (services.synonyms, masters) —
 * см. services/slots.ts. Здесь только то, что нужно автомату.
 */
export const norm = normalize;   // алиас для кода дней 2–3

const todayOf = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate());

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const YES = new Set([
  'да', 'даа', 'ага', 'агаа', 'угу', 'угум', 'ок', 'окей', 'окк', 'хорошо', 'все верно', 'верно',
  'подтверждаю', 'давай', 'д', 'yes', 'ok', 'согласен', 'согласна', 'да да',
]);

const NO = new Set([
  'нет', 'неа', 'не', 'не нет', 'не согласен', 'не согласна', 'no', 'nope', 'не хочу',
]);

/** Слова, которые похожи на имя, но именем не являются. */
const NAME_STOP = new Set([
  'да', 'нет', 'неа', 'ок', 'окей', 'хорошо', 'верно', 'спасибо', 'пожалуйста',
  'привет', 'здравствуйте', 'мастер', 'мастера', 'мастеру', 'любой', 'любого',
  'неважно', 'пропустить', 'без', 'имени', 'имя', 'это', 'я', 'мне', 'меня',
  'вас', 'ваше', 'зовут', 'можно', 'подскажите', 'скажите', 'хочу', 'не',
  'записаться', 'перенести', 'отменить', 'время', 'дата', 'телефон', 'адрес',
  'цена', 'сколько', 'стоит', 'стрижка', 'борода', 'бритье', 'укладка',
]);

/**
 * Имя в ответ на «Как вас зовут?». Принимаем одно слово кириллицей,
 * но не служебные слова, услуги и ответы «да/нет».
 */
export function looksLikeName(text: string): string | undefined {
  const t = text.trim();
  if (!/^[а-яё][а-яё-]{1,19}$/u.test(t)) return undefined;
  if (NAME_STOP.has(t) || YES.has(t) || NO.has(t)) return undefined;
  if (matchService(t)) return undefined;
  return t;
}

const FAQ_RE = /(сколько стоит|стоимост|цен|прайс|адрес|где вы|находитесь|как работаете|когда работаете|правил|открыва|закрыва|работаете|что входит|без записи|отмен|перенос|до скольки|опозда|предоплат|сертификат|парковк|оплат|есть ли|нужна ли)/;

/**
 * Вопрос, а не команда. Знак вопроса — самый надёжный признак, но клиенты
 * часто его не ставят, поэтому смотрим и на вопросительное начало фразы.
 */
const QUESTION_RE = /(?:\?|^\s*(?:а\s+)?(?:можно|скажите|подскажите|не\s+подскажете|сколько|за\s+сколько|во\s+сколько|до\s+скольки|где|когда|как|что|есть|работаете|нужна|нужно|почему|какой|какие|расскажите|хочу\s+узнать)(?![\p{L}\d]))/iu;

/**
 * Явная просьба что-то сделать. Она сильнее FAQ-словаря: «хочу записаться
 * и узнать цену» — это запись с попутным вопросом, а не вопрос вместо записи.
 */
const ACTION_REQUEST_RE = /(?:(?:хочу|хотел[аи]?|мне\s+(?:нужно|надо)|давайте)\s+[^,.!?]{0,25}(?:записаться|записатся|забронировать|отменить|перенести|на\s)|(?:запишите|отмените|перенесите))/iu;

/** Клиент задал вопрос — возможно, вместе с просьбой записаться. */
export const hasFaqQuestion = (text: string): boolean => FAQ_RE.test(text);

const detectIntent = (text: string, raw = ''): NluIntent => {
  if (/(оператор|администратор|человек|менеджер|живого|живой|жалоб)/.test(text)) return 'handoff';

  // «За сколько часов можно отменить?» содержит слово «отменить», но это
  // вопрос о правилах, а не команда отмены. Сначала отделяем вопрос.
  const isQuestion = QUESTION_RE.test(raw) || QUESTION_RE.test(text);
  if (FAQ_RE.test(text) && isQuestion && !ACTION_REQUEST_RE.test(text)) return 'faq';

  if (/(отмени|отмена|отмену|отмен)/.test(text)) return 'cancel';
  if (/(перенес|перенос|перенести|перенеси|другой день|другое время|передвинуть)/.test(text)) return 'reschedule';
  if (/(запис|запиш|забронир|подстр|постр|стрич|свободн(ое|ые|ый) (время|окно|день)|место есть|хочу на)/.test(text)) return 'booking';
  if (FAQ_RE.test(text)) return 'faq';
  return 'unknown';
};

export async function understand(ctx: Ctx, text: string, now: Date): Promise<Nlu> {
  const t = norm(text);
  const nlu: Nlu = { intent: 'unknown', text: t };

  if (YES.has(t)) nlu.yes = true;
  if (NO.has(t)) nlu.no = true;

  const service = matchService(t);
  if (service) nlu.service = service;

  const when = parseWhen(t, now);
  if (when.date) nlu.date = when.date;
  if (when.time) nlu.time = when.time;
  if (when.timeRange) nlu.timeRange = when.timeRange;
  if (when.ambiguous) nlu.ambiguous = when.ambiguous;

  // «18» в ответ на вопрос о времени — это час, а не «18-е число».
  // В списке окон «13 диана» — тоже время и мастер, а не 13-е число.
  const awaitingTime = ctx.lastAsked === 'ASK_TIME' || ctx.state === 'OFFER_SLOTS';
  if (!nlu.time && !nlu.timeRange && nlu.date && awaitingTime) {
    const bare = parseBareHour(t) ?? parseBareHourInText(text);
    const raw = /(?<![\p{L}\d])(\d{1,2})(?![\p{L}\d])/u.exec(t)?.[1];
    const rawHour = raw ? Number(raw) : 0;
    // В OFFER_SLOTS числа 1–3 — номера вариантов, а не часы.
    const optionNumber = ctx.state === 'OFFER_SLOTS' && rawHour >= 1 && rawHour <= 3;
    if (bare && !optionNumber) {
      nlu.time = bare;
      delete nlu.date;
    }
  }

  const phone = parsePhone(text, ctx.slots.phoneDraft);
  if (phone.status === 'ok') {
    nlu.phone = phone.phone;
  } else if (phone.status !== 'none') {
    nlu.digits = phone.digits;
    nlu.phoneStatus = phone.status;
  }

  const name = t.match(/(?:меня\s+зовут|зовут|мое имя|моё имя|имя)\s+([а-я]{2,})/);
  if (name) nlu.name = name[1];
  // На вопрос «Как вас зовут?» часто отвечают просто именем: «Иван».
  if (!nlu.name && ctx.lastAsked === 'ASK_NAME') {
    const bare = looksLikeName(t);
    if (bare) nlu.name = bare;
  }

  nlu.intent = detectIntent(t, text);

  // Светская реплика — отдельный слой. Она не должна перехватывать дату,
  // время, телефон, имя или мастера: «спасибо, к Артёму» — это выбор мастера.
  const smalltalk = detectSmalltalk(t);
  const actionable = nlu.date || nlu.time || nlu.timeRange || nlu.phone
    || nlu.digits || nlu.name || matchMaster(t);
  if (smalltalk) {
    if (nlu.intent === 'unknown' && !actionable) {
      nlu.intent = 'smalltalk';
      nlu.smalltalk = smalltalk;
    }
    // «Ты человек?» правила сначала принимают за просьбу позвать человека.
    // Это вопрос о боте, а не эскалация: smalltalk отвечает и сохраняет состояние.
    if (smalltalk === 'bot' && nlu.intent === 'handoff'
      && !/(оператор|администратор|менеджер|жалоб)/.test(t)) {
      nlu.intent = 'smalltalk';
      nlu.smalltalk = 'bot';
    }
  }

  // «стрижка» без глагола — тоже намерение записаться
  if (nlu.intent === 'unknown' && nlu.service) nlu.intent = 'booking';

  // Правила отработали: если реплика сложная, модель добирает недостающее
  // (день 10). Её ответ проходит проверку и не перезаписывает правила.
  const out = await refineWithLlm(nlu, text, ctx, now);

  // Модель не имеет права выдумать smalltalk: только детектор правил решает,
  // что реплика светская. Иначе «ну когда-нибудь потом» превращалось в
  // болтовню и сбрасывало счётчик непониманий.
  if (out.intent === 'smalltalk') {
    if (!smalltalk || actionable) {
      out.intent = 'unknown';
      delete out.smalltalk;
    } else {
      out.smalltalk = smalltalk;
    }
  }
  return out;
}

/** «сегодня», «завтра», «во вторник, 20 октября». */
export function formatDate(date: string, now: Date): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const today = todayOf(now);
  const diff = Math.round((dt.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  if (diff === 2) return 'послезавтра';
  const wd = ['в воскресенье', 'в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу'][dt.getDay()];
  return `${wd}, ${d} ${MONTHS[m - 1]}`;
}
