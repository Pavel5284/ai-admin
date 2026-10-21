/**
 * Разбор дат: когда клиент хочет прийти.
 * Дни 5–6 гайда. На вход приходит уже нормализованный текст.
 */

import {afterCorrection, wb} from './normalize';
import { findNumbers } from './numbers';
import { parseTimeRules } from './time';

export type ParsedWhen = {
  date?: string;                           // 'YYYY-MM-DD'
  time?: string;                           // 'HH:mm'
  timeRange?: { from: string; to: string };
  ambiguous?: string[];                    // что нужно уточнить у клиента
};

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const todayOf = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate());

const addDays = (d: Date, n: number): Date => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
};

/** Месяцы во всех падежах, которые встречаются в речи. */
const MONTHS: Record<string, number> = {
  январь: 1, января: 1, январе: 1, январю: 1,
  февраль: 2, февраля: 2, феврале: 2, февралю: 2,
  март: 3, марта: 3, марте: 3, марту: 3,
  апрель: 4, апреля: 4, апреле: 4, апрелю: 4,
  май: 5, мая: 5, мае: 5, маю: 5,
  июнь: 6, июня: 6, июне: 6, июню: 6,
  июль: 7, июля: 7, июле: 7, июлю: 7,
  август: 8, августа: 8, августе: 8, августу: 8,
  сентябрь: 9, сентября: 9, сентябре: 9, сентябрю: 9,
  октябрь: 10, октября: 10, октябре: 10, октябрю: 10,
  ноябрь: 11, ноября: 11, ноябре: 11, ноябрю: 11,
  декабрь: 12, декабря: 12, декабре: 12, декабрю: 12,
};

/** Дни недели. Ноль — воскресенье, как в Date.getDay(). В винительном падеже: «в среду». */
const WEEKDAYS: Record<string, number> = {
  воскресенье: 0, воскресенья: 0,
  понедельник: 1, понедельника: 1, понедельнику: 1,
  вторник: 2, вторника: 2, вторнику: 2,
  среда: 3, среды: 3, среде: 3, среду: 3,
  четверг: 4, четверга: 4, четвергу: 4,
  пятница: 5, пятницы: 5, пятнице: 5, пятницу: 5,
  суббота: 6, субботы: 6, субботе: 6, субботу: 6,
};

type Hit = { date: string; start: number; end: number };

/**
 * «Съесть» найденный фрагмент: заменяем его пробелами, чтобы следующее
 * правило не увидело те же цифры. Именно это спасает от «23 10»,
 * которое иначе прочиталось бы и как дата, и как время.
 */
const eat = (text: string, start: number, end: number): string =>
  text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);

const hit = (date: string, m: RegExpExecArray): Hit => ({
  date, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length,
});

/** «15 числа», когда сегодня 20-е, — это 15-го следующего месяца. */
const dayInMonth = (today: Date, day: number): string => {
  let d = new Date(today.getFullYear(), today.getMonth(), day);
  if (d.getTime() < today.getTime()) d = new Date(today.getFullYear(), today.getMonth() + 1, day);
  return iso(d);
};

/** Ближайший день недели с номером target (0 — воскресенье), не раньше from. */
const nearestWeekday = (from: Date, target: number): Date => {
  for (let add = 0; add < 8; add++) {
    const d = addDays(from, add);
    if (d.getDay() === target) return d;
  }
  return from;
};

/** «послезавтра», «завтра», «сегодня», «через 3 дня», «через неделю». */
function relativeDay(text: string, today: Date): Hit | null {
  const rules: Array<[RegExp, (m: RegExpExecArray) => number]> = [
    [wb('послезавтра'), () => 2],
    [wb('сегодня'), () => 0],
    [wb('завтра'), () => 1],
    [wb(String.raw`через\s+(\d+)\s*(?:день|дня|дней)`), (m) => Number(m[1])],
    [wb(String.raw`через\s+(\d+)\s*недел[\p{L}\d]*`), (m) => Number(m[1]) * 7],
    [wb(String.raw`через\s+(неделю|месяц)`), (m) => (m[1] === 'месяц' ? 30 : 7)],
  ];
  for (const [re, calc] of rules) {
    const m = re.exec(text);
    if (!m) continue;
    return { date: iso(addDays(today, calc(m))), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length };
  }
  return null;
}

/** «23 числа», «23 октября», «23.10», «23.10.2026». */
function dayOfMonth(text: string, today: Date): Hit | null {
  // «23 числа»
  const withWord = wb(String.raw`(\d{1,2})\s*(?:числа|число)`).exec(text);
  if (withWord) {
    const day = Number(withWord[1]);
    if (day >= 1 && day <= 31) return { date: dayInMonth(today, day), start: withWord.index ?? 0, end: (withWord.index ?? 0) + withWord[0].length };
  }

  // «23 октября»
  const withMonth = wb(String.raw`(\d{1,2})\s+(${Object.keys(MONTHS).join('|')})`).exec(text);
  if (withMonth) {
    const day = Number(withMonth[1]);
    const month = MONTHS[withMonth[2].toLowerCase()];
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      let d = new Date(today.getFullYear(), month - 1, day);
      if (d.getTime() < today.getTime()) d = new Date(today.getFullYear() + 1, month - 1, day);
      return hit(iso(d), withMonth);
    }
  }

  // «23.10» и «23.10.2026». Проверка месяца (1–12) спасает от телефонов вида «+7 916.234.56.78».
  const numeric = /(?<![\p{L}\d])(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?![\p{L}\d])/u.exec(text);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      let year = numeric[3] ? Number(numeric[3]) : today.getFullYear();
      if (year < 100) year += 2000;
      let d = new Date(year, month - 1, day);
      if (!numeric[3] && d.getTime() < today.getTime()) d = new Date(year + 1, month - 1, day);
      return hit(iso(d), numeric);
    }
  }

  return null;
}

/** «в среду», «в ближайшую пятницу», «в следующий вторник», «на выходных». */
function weekday(text: string, today: Date): Hit | null {
  const names = Object.keys(WEEKDAYS).join('|');

  // «в следующий вторник» — вторник следующей недели
  const next = wb(String.raw`(?:в\s+)?следующ[\p{L}\d]*\s+(${names})`).exec(text);
  if (next) {
    const target = WEEKDAYS[next[1].toLowerCase()];
    const monday = addDays(today, 7 - ((today.getDay() + 6) % 7));   // понедельник следующей недели
    return hit(iso(nearestWeekday(monday, target)), next);
  }

  // «в ближайшую пятницу»
  const nearest = wb(String.raw`(?:в\s+)?ближайш[\p{L}\d]*\s+(${names})`).exec(text);
  if (nearest) {
    return hit(iso(nearestWeekday(today, WEEKDAYS[nearest[1].toLowerCase()])), nearest);
  }

  // «в выходные» — ближайшая суббота
  const weekend = wb(String.raw`(?:в|на)\s+выходны[\p{L}\d]*`).exec(text);
  if (weekend) return hit(iso(nearestWeekday(today, 6)), weekend);

  // «в пятницу»
  const plain = wb(String.raw`(?:в|на|к)\s+(${names})`).exec(text);
  if (plain) {
    return hit(iso(nearestWeekday(today, WEEKDAYS[plain[1].toLowerCase()])), plain);
  }

  return null;
}

/**
 * Одиночное число без других маркеров — день месяца.
 * После нормализации «двадцать третьего» превратилось в «23».
 * Число не должно быть частью времени: «в 15 30», «15:30» — это не дата.
 */
function bareDay(text: string, today: Date): string | null {
  const numbers = findNumbers(text);
  for (const n of numbers) {
    if (n.value < 1 || n.value > 31) continue;

    const prev = numbers.find((o) => o !== n && o.end <= n.start);
    const next = numbers.find((o) => o !== n && o.start >= n.end);
    if (prev && n.start - prev.end <= 1) continue;   // «15 30» — два числа подряд
    if (next && next.start - n.end <= 1) continue;

    if (/(^|\s)в\s*$/.test(text.slice(0, n.start))) continue;  // «в 6» — это час
    if (text.slice(n.end).startsWith(':')) continue;            // «15:30» — это время

    return dayInMonth(today, n.value);
  }
  return null;
}

/** Главная функция раздела: что и когда хочет клиент. */
export function parseWhen(text: string, now: Date): ParsedWhen {
  const today = todayOf(now);
  const out: ParsedWhen = {};
  let work = afterCorrection(text);

  const rel = relativeDay(work, today);
  if (rel) { out.date = rel.date; work = eat(work, rel.start, rel.end); }

  const dom = dayOfMonth(work, today);
  if (dom) { out.date = dom.date; work = eat(work, dom.start, dom.end); }

  const wd = weekday(work, today);
  if (wd) { out.date = wd.date; work = eat(work, wd.start, wd.end); }

  if (!out.date) {
    const bare = bareDay(work, today);
    if (bare) out.date = bare;
  }

  const time = parseTimeRules(work);
  if (time.time) out.time = time.time;
  if (time.timeRange) out.timeRange = time.timeRange;
  if (time.ambiguous) out.ambiguous = time.ambiguous;

  // «на следующей неделе» без дня — уточнить у клиента
  if (!out.date && wb(String.raw`следующ[\p{L}\d]*\s+недел[\p{L}\d]*`).test(work)) {
    out.ambiguous = [...(out.ambiguous ?? []), 'date'];
  }

  return out;
}
