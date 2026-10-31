/**
 * Телефоны из речи. День 6 гайда (раздел 2.5).
 *
 * На вход — сырая реплика клиента: «восемь девятьсот шестнадцать…»,
 * «8 (916) 234-56-78», «мой номер 89162345678».
 * На выходе — статус и, если цифр хватило, нормализованный номер.
 */

import {afterCorrection, normalize, wb} from './normalize';

export type PhoneResult =
  | { status: 'ok'; phone: string }          // '+79162345678'
  | { status: 'partial'; digits: string }    // не хватает цифр: просим повторить целиком
  | { status: 'too_long'; digits: string }   // лишние цифры: просим повторить целиком
  | { status: 'none' };                      // цифр нет вообще

/** Слова, после которых идёт сам номер. */
const MENTION = /телефон|номер|тел\b|звон|вот номер/i;

/**
 * «Двойной ноль», «два нуля», «три девятки» — словами, которые не разбираются
 * как числа: «два нуля» превратилось бы в «2». Заменяем до разбора чисел.
 * Границы слов — через wb(): обычный \b кириллицу не видит.
 */
const SPOKEN_GROUPS: Array<[RegExp, string]> = [
  [wb(String.raw`(?:двойной|двойные)\s+ноль(?:ь|я|ей)?`), '00'],
  [wb(String.raw`два\s+нул(?:я|и)`), '00'],
  [wb(String.raw`три\s+нул(?:я|и)`), '000'],
  [wb(String.raw`две\s+девятки`), '99'],
  [wb(String.raw`три\s+девятки`), '999'],
];

/** Приводит цифры к виду +7XXXXXXXXXX. */
export const toE164 = (digits: string): string | null => {
  if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7')) return '+7' + digits.slice(1);
  if (digits.length === 10 && digits[0] === '9') return '+7' + digits;
  return null;
};

export function parsePhone(text: string): PhoneResult {
  // 1. Берём хвост после слова «телефон»/«номер»: иначе в номер попадут
  //    цифры даты и времени. Если в хвосте цифр нет — берём всю реплику.
  const parts = text.split(MENTION);
  const afterMention = parts.length > 1 ? parts[parts.length - 1] ?? '' : '';
  // «Номер восемь девятьсот…»: слова-числительные тоже номер, поэтому хвост
  // после слова «номер» берём, даже если в нём ещё нет готовых цифр.
  const tail = afterCorrection(afterMention.trim() ? afterMention : text);

  // 2. Убираем время и даты, которые стоят рядом с номером.
  let prepared = tail
    .replace(/\d{1,2}\s*:\s*\d{2}/g, ' ')                                      // 18:00
    .replace(/(^|\s)в\s+\d{1,2}(?!\d)/g, ' ')                                     // «в 18»
    .replace(/(?<![\d.,\-])\d{1,2}[.\-/]\d{1,2}(?:[.\-/]\d{2,4})?(?![\d])/g, ' '); // 23.10

  // 3. «Два нуля» → «00», дальше нормализация: слова-числа становятся цифрами.
  for (const [re, digits] of SPOKEN_GROUPS) prepared = prepared.replace(re, digits);
  const normalized = normalize(prepared);

  // 4. Оставляем только цифры.
  const digits = normalized.replace(/\D/g, '');

  // 5. Номер всегда разбираем как самостоятельную реплику: неполный ввод
  //    не копим между сообщениями, а просим клиента повторить номер целиком.
  const all = digits;

  if (!all) return { status: 'none' };
  if (all.length >= 10) {
    // 11 цифр с восьмёркой или семёркой и 10 цифр с девяткой — это один и тот же номер.
    const phone = toE164(all);
    if (phone) return { status: 'ok', phone };
  }
  if (all.length > 11) return { status: 'too_long', digits: all };
  if (all.length === 11) {
    // 11 цифр, но формат не тот (начинается не с 7 или 8) — надо сказать заново.
    return { status: 'too_long', digits: all };
  }
  return { status: 'partial', digits: all };
}
