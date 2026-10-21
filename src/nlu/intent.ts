import type { Ctx } from '../dialog/states';
import { normalize } from './normalize';
import { parseWhen } from './dates';
import { parseBareHour } from './time';
import { parsePhone } from './phone';

/**
 * Разбор реплики: интент и слоты.
 * Нормализация, числительные, даты и время живут в соседних модулях
 * (normalize.ts, numbers.ts, dates.ts, time.ts) — здесь только то, что нужно автомату.
 */

export type NluIntent = 'booking' | 'reschedule' | 'cancel' | 'faq' | 'handoff' | 'unknown';

export type Nlu = {
  intent: NluIntent;
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

/** До дня 8 словарь услуг живёт в таблице services (services.synonyms), здесь временная копия. */
export const SERVICE_TITLES: Record<string, string> = {
  haircut: 'Мужская стрижка',
  beard: 'Оформление бороды',
  combo: 'Стрижка + борода',
  kids: 'Детская стрижка',
  shave: 'Королевское бритьё',
  styling: 'Укладка',
};

export const serviceTitle = (code?: string): string | undefined => (code ? SERVICE_TITLES[code] : undefined);

const SERVICE_BASES: Array<[string, string]> = [
  ['детск', 'kids'],
  ['брит', 'shave'],
  ['комплекс', 'combo'],
  ['кладк', 'styling'],
  ['бород', 'beard'],
  ['стрижк', 'haircut'],
];

const MASTER_NAMES = ['артем', 'руслан', 'диана'];

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

export const norm = normalize;   // алиас для кода дней 2–3

const todayOf = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate());

export function matchService(text: string): string | undefined {
  const has = (base: string) => text.includes(base);
  if (has('стрижк') && has('бород')) return 'combo';
  for (const [base, code] of SERVICE_BASES) if (has(base)) return code;
  return undefined;
}

export const matchMaster = (text: string): string | undefined =>
  MASTER_NAMES.find((name) => text.includes(name));

const FAQ_RE = /(сколько стоит|стоимост|цена|цены|прайс|адрес|где вы|находитесь|как работаете|когда работаете|правил|открыт|работаете ли|что входит)/;

/** Клиент задал вопрос — возможно, вместе с просьбой записаться. */
export const hasFaqQuestion = (text: string): boolean => FAQ_RE.test(text);

const detectIntent = (text: string): NluIntent => {
  if (/(оператор|администратор|человек|менеджер|живого|живой|жалоб)/.test(text)) return 'handoff';
  if (/(отмени|отмена|отмену|отмен)/.test(text)) return 'cancel';
  if (/(перенес|перенос|перенести|перенеси|другой день|другое время|передвинуть)/.test(text)) return 'reschedule';
  if (/(запис|запиш|забронир|свободн(ое|ые|ый) (время|окно|день)|место есть|хочу на)/.test(text)) return 'booking';
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
  if (!nlu.time && !nlu.timeRange && nlu.date && ctx.lastAsked === 'ASK_TIME') {
    const bare = parseBareHour(t);
    if (bare) {
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

  nlu.intent = detectIntent(t);
  // «стрижка» без глагола — тоже намерение записаться
  if (nlu.intent === 'unknown' && nlu.service) nlu.intent = 'booking';

  return nlu;
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
