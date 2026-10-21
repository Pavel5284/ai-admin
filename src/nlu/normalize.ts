/**
 * Нормализация текста перед разбором. День 4 гайда.
 *
 * Порядок шагов задан гайдом и менять его не стоит:
 *   1. регистр и ё → е;
 *   2. чистка пунктуации;
 *   3. удаление слов-паразитов;
 *   4. исправление типичных ошибок распознавания;
 *   5. перевод числительных в цифры (модуль numbers.ts).
 */

import { wordsToDigits } from './numbers';

/**
 * Граница слова для кириллицы: обычные \b и \w её не видят.
 * wb('завтра').test('на завтра в шесть') → true
 * wb('завтра').test('назавтра')          → false
 */
export const wb = (src: string): RegExp =>
  new RegExp(String.raw`(?<![\p{L}\d])(?:${src})(?![\p{L}\d])`, 'iu');

/** Слова-паразиты: длинные варианты идут первыми, иначе «мм» съест «ммм». */
export const FILLERS = [
  'ну', 'эээ', 'ээ', 'ммм', 'мм', 'короче', 'значит', 'вот', 'типа', 'как бы',
];

const FILLER_RE = new RegExp(
  String.raw`(?<![\p{L}\d])(?:${FILLERS.map((f) => f.split(' ').join(String.raw`\s+`)).join('|')})(?![\p{L}\d])`,
  'giu',
);

/**
 * Ошибки распознавания речи: склейки и разрывы слов.
 * Список пополняется по мере нахождения багов — каждый новый баг сначала
 * становится тестом, потом сюда добавляется замена.
 */
export const ASR_FIXES: Record<string, string> = {
  'назавтра': 'на завтра',        // склейка
  'на- завтра': 'на завтра',      // склейка с дефисом
  'во скок': 'во сколько',        // огрех распознавания
  'все гда': 'всегда',
  'покарю': 'покажу',
};

/**
 * Приводит реплику к стабильному виду.
 * Пунктуация заменяется пробелом, кроме трёх знаков, которые несут смысл:
 * «:» держит время («в 18:00»), «-» — порядковое окончание («23-го»),
 * «.» — дату в формате «23.10».
 */
export function normalize(text: string): string {
  let t = text.toLowerCase().replace(/ё/g, 'е');
  t = t.replace(/[,!?;()[\]«»"]/g, ' ');
  t = t.replace(FILLER_RE, ' ');

  for (const [wrong, right] of Object.entries(ASR_FIXES)) {
    const escaped = wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(String.raw`(?<![\p{L}\d])${escaped}(?![\p{L}\d])`, 'giu'), right);
  }

  t = wordsToDigits(t);

  return t.replace(/\s+/g, ' ').trim();
}

/** Клиент поправил себя: «завтра, нет, в четверг» — берём только часть после «нет». */
const CORRECTION_RE = /(?<![\p{L}\d])(нет|точнее|лучше|вернее|извините|прошу)(?![\p{L}\d])/giu;

export function afterCorrection(text: string): string {
  const marks = [...text.matchAll(CORRECTION_RE)];
  if (!marks.length) return text;
  const last = marks[marks.length - 1];
  return text.slice((last.index ?? 0) + last[0].length);
}
