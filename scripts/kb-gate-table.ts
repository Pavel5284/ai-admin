/**
 * Таблица компромисса для порога RAG (день 13, раздел 3.4).
 *
 * Прогоняет одни и те же 30 вопросов (20 «ответ есть», 10 «ответа нет»)
 * через настоящий `answerKb` при разных порогах KB_DIST_MAX и считает,
 * сколько вопросов ответил бот и сколько ответов выдумал при том,
 * что в базе ответа нет. Вторая таблица в reports/kb-thresholds.md
 * — она и обосновывает выбранный порог в README.
 *
 * Запуск: `npx tsx scripts/kb-gate-table.ts` (нужна загруженная kb_chunks,
 * ключи EMBED_API_KEY/LLM_API_KEY, кэш LLM включён — повторные прогоны дешёвые).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { answerKb } from '../src/services/kb';

const WITH_ANSWER = [
  'Сколько стоит мужская стрижка?', 'Сколько стоит оформление бороды?',
  'Сколько стоит стрижка и борода вместе?', 'Сколько стоит детская стрижка?',
  'Сколько стоит бритьё опасной бритвой?', 'Сколько стоит укладка?',
  'До скольки вы работаете?', 'Во сколько открывается барбершоп?',
  'Где вы находитесь, какой адрес?', 'Как пройти от метро?',
  'Можно ли бесплатно отменить запись?', 'За сколько часов можно перенести запись?',
  'Что будет, если я опоздаю?', 'Нужна ли предоплата?', 'Как можно оплатить услуги?',
  'Можно ли прийти без записи?', 'К какому мастеру можно записаться?',
  'Работаете ли вы с детьми?', 'Есть ли подарочные сертификаты?', 'Где можно оставить машину?',
];

const WITHOUT_ANSWER = [
  'Делаете ли вы татуировки?', 'Сколько стоит окрашивание волос?', 'Можно ли у вас сделать маникюр?',
  'Продаёте ли вы профессиональную косметику?', 'Можно ли записаться на наращивание ресниц?',
  'Делаете ли вы выезд к клиенту на дом?', 'Есть ли у вас Wi-Fi?', 'Можно ли оплатить криптовалютой?',
  'Делаете ли вы массаж?', 'Можно ли оставить у вас питомца?',
];

const pause = () => new Promise((r) => setTimeout(r, 300));

type Question = { q: string; answerable: boolean };
const all: Question[] = [
  ...WITH_ANSWER.map((q) => ({ q, answerable: true })),
  ...WITHOUT_ANSWER.map((q) => ({ q, answerable: false })),
];

type Stats = { answeredOk: number; falseRefusal: number; hallucinated: number; refused: number };

async function run(threshold: number): Promise<Stats> {
  process.env.KB_DIST_MAX = String(threshold);
  const stats: Stats = { answeredOk: 0, falseRefusal: 0, hallucinated: 0, refused: 0 };
  for (const item of all) {
    const kb = await answerKb(item.q);
    const answered = kb.answerable && !!kb.answer;
    if (item.answerable) {
      if (answered) stats.answeredOk++;
      else stats.falseRefusal++;
    } else {
      // Ответ на вопрос, которого в базе нет, — это и есть выдумка.
      if (answered) stats.hallucinated++;
      else stats.refused++;
    }
    await pause();                                     // эмбеддинги идут с лимитами
  }
  return stats;
}

const THRESHOLDS = [0.14, 0.16, 0.18, 0.2, 0.22, 0.99]; // 0.99 ≈ порог выключен (верхняя граница)
// Строго последовательно: порог передаётся через process.env, параллельность исказила бы его.
const results: Stats[] = [];
for (const t of THRESHOLDS) results.push(await run(t));

const rows = THRESHOLDS.map((t, i) => {
  const s = results[i];
  return `| ${t === 0.99 ? 'без порога' : t} | ${s.answeredOk}/20 | ${s.falseRefusal} | **${s.hallucinated}/10** | ${s.refused} |`;
});

const md = [
  '',
  '## Таблица компромисса: порог → ответил / выдумал (день 13)',
  '',
  'Те же вопросы, пропущенные через настоящий `answerKb` (4 фрагмента + модель)',
  'при разных порогах. «Выдумал» — бот ответил, хотя ответа в базе нет.',
  '',
  '| KB_DIST_MAX | Ответил (есть ответ) | Ложный отказ | Выдумал | Честно отказался |',
  '| --- | --- | --- | --- | --- |',
  ...rows,
  '',
].join('\n');

console.log(md);

// Секция перезаписывается при повторном прогоне: не оставляем в отчёте дублей.
const REPORT = 'reports/kb-thresholds.md';
let existing = '';
try { existing = await readFile(REPORT, 'utf8'); } catch { /* файла ещё нет */ }
const marker = '## Таблица компромисса';
const keep = existing.includes(marker) ? existing.slice(0, existing.indexOf(marker)).trimEnd() + '\n' : existing;
await writeFile(REPORT, keep + md);
console.log('Секция обновлена в: ' + REPORT);