/**
 * Калибровка порога RAG (день 13 гайда, раздел 3.4).
 *
 * Прогонает 20 вопросов, на которые ответ в базе есть, и 10, на которых его
 * нет, печатает dist лучшего фрагмента для каждого и предлагает границу между
 * двумя группами. Таблица сохраняется в reports/kb-thresholds.md — она идёт
 * в README как измеренное обоснование порога KB_DIST_MAX.
 *
 * Запуск: `npx tsx scripts/kb-threshold.ts` (нужна загруженная kb_chunks
 * и ключ EMBED_API_KEY). Сами ответы модели не пробуются: порог выбирается
 * по расстояниям и проверяется скриптом вручную.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { Answer, distMax, numbersOk, searchKb } from '../src/services/kb';
import { complete, tryJson } from '../src/services/llm';

const WITH_ANSWER = [
  'Сколько стоит мужская стрижка?',
  'Сколько стоит оформление бороды?',
  'Сколько стоит стрижка и борода вместе?',
  'Сколько стоит детская стрижка?',
  'Сколько стоит бритьё опасной бритвой?',
  'Сколько стоит укладка?',
  'До скольки вы работаете?',
  'Во сколько открывается барбершоп?',
  'Где вы находитесь, какой адрес?',
  'Как пройти от метро?',
  'Можно ли бесплатно отменить запись?',
  'За сколько часов можно перенести запись?',
  'Что будет, если я опоздаю?',
  'Нужна ли предоплата?',
  'Как можно оплатить услуги?',
  'Можно ли прийти без записи?',
  'К какому мастеру можно записаться?',
  'Работаете ли вы с детьми?',
  'Есть ли подарочные сертификаты?',
  'Где можно оставить машину?',
];

const WITHOUT_ANSWER = [
  'Делаете ли вы татуировки?',
  'Сколько стоит окрашивание волос?',
  'Можно ли у вас сделать маникюр?',
  'Продаёте ли вы профессиональную косметику?',
  'Можно ли записаться на наращивание ресниц?',
  'Делаете ли вы выезд к клиенту на дом?',
  'Есть ли у вас Wi-Fi?',
  'Можно ли оплатить криптовалютой?',
  'Делаете ли вы массаж?',
  'Можно ли оставить у вас питомца?',
];

/** Небольшая пауза между запросами — эмбеддинги идут в бесплатный API с лимитами. */
const pause = () => new Promise((r) => setTimeout(r, 400));

type Row = { q: string; answerable: boolean; dist: number | null; title: string; ok: boolean | null };

async function measure(question: string, answerable: boolean): Promise<Row> {
  const chunks = await searchKb(question);
  const best = chunks[0] ?? null;
  let ok: boolean | null = null;
  if (best) {
    ok = await verify(question, best);                   // модель отвечает по фрагменту? (429 -> повторяет embed внутри searchKb)
  }
  await pause();
  return { q: question, answerable, dist: best?.dist ?? null, title: best?.title ?? '—', ok };
}

/** Как модель отвечает на вопрос по топ-1 фрагменту: ищем только выдумки в числах. */
async function verify(question: string, best: { id: number; title: string; text: string }): Promise<boolean> {
  const chunk = { id: best.id, title: best.title, text: best.text, dist: 0 };
  const raw = await complete({
    system:
      'Ты отвечаешь на вопросы клиентов барбершопа по фрагменту его базы знаний. Отвечай ТОЛЬКО по ' +
      'фрагменту, числа приводи ровно как в нём. Если ответа во фрагменте нет — верни ' +
      '{"answerable": false, "answer": "", "source_ids": []}. Иначе ' +
      '{"answerable": true, "answer": "...", "source_ids": [' + chunk.id + ']}. Только JSON.',
    user: `Вопрос: ${question}\nФрагмент [id ${chunk.id}] ${chunk.title}\n${chunk.text}`,
    maxTokens: 700,
  });
  const parsed = Answer.safeParse(tryJson(raw));
  if (!parsed.success || !parsed.data.answerable || !parsed.data.answer) return false;
  return parsed.data.source_ids.includes(chunk.id) && numbersOk(parsed.data.answer, [chunk]);
}

const fmt = (n: number | null) => (n === null ? '—' : n.toFixed(3));

const rows: Row[] = [];
for (const q of WITH_ANSWER) rows.push(await measure(q, true));
for (const q of WITHOUT_ANSWER) rows.push(await measure(q, false));

const yes = rows.filter((r) => r.answerable && r.dist !== null);
const no = rows.filter((r) => !r.answerable && r.dist !== null);
const yesDist = yes.map((r) => r.dist!);
const noDist = no.map((r) => r.dist!);
const yesMin = yesDist.length ? Math.min(...yesDist) : null;
const yesMax = yesDist.length ? Math.max(...yesDist) : null;
const noMin = noDist.length ? Math.min(...noDist) : null;
const noMax = noDist.length ? Math.max(...noDist) : null;
const separable = yesMax !== null && noMin !== null && yesMax < noMin;
const suggested = separable ? Math.round(((yesMax! + noMin!) / 2) * 1000) / 1000 : null;

const line = (r: Row) =>
  `| ${r.answerable ? 'да' : 'нет'} | ${r.q} | ${r.title} | ${fmt(r.dist)} | ${
    r.ok === null ? '—' : r.ok ? 'по фрагменту' : '**выдумка**'
  } |`;

const md = [
  '# Калибровка порога RAG (день 13)',
  '',
  `Дата: ${new Date().toISOString().slice(0, 10)}. Модель эмбеддингов: ${(process.env.EMBED_MODEL ?? 'mistral-embed')}`,
  '',
  'Порог нужен, чтобы бот не отвечал на вопросы, которых нет в базе: замеряем `dist`',
  '(косинусное расстояние до лучшего фрагмента) у вопросов «ответ есть» и «ответа нет»',
  'и ищем границу между группами. Колонка «лучший фрагмент» показывает, что нашёл поиск.',
  '',
  '| Ответ в базе | Вопрос | Лучший фрагмент | dist | Модель по одному фрагменту |',
  '| --- | --- | --- | --- | --- |',
  ...[...rows].sort((a, b) => (a.dist ?? 9) - (b.dist ?? 9)).map(line),
  '',
  yesMin === null
    ? '- Вопросы «ответ есть» не замерялись'
    : '- Ответы есть: dist от **' + fmt(yesMin) + '** до **' + fmt(yesMax) + '** (max)',
  noMin === null
    ? '- Вопросы «ответа нет» не замерялись'
    : '- Ответов нет: dist от **' + fmt(noMin) + '** (min) до **' + fmt(noMax) + '**',
  separable
    ? `- Группы разделимы. Предложенный порог: **${suggested}** (середина между max «да» и min «нет»).`
    : `- Группы пересекаются (max «да» ${fmt(yesMax)} vs min «нет» ${fmt(noMin)}): порог смещаем вправо —`,
  separable ? '' : '  ложный отказ дешевле выдумки, поэтому границу ставим ближе к «ответам есть».',
  `Текущая настройка: KB_DIST_MAX=${distMax()}.`,
  '',
].join('\n').replace(/\n{3,}/g, '\n\n');

console.log(md);
await mkdir('reports', { recursive: true });
await writeFile('reports/kb-thresholds.md', md);
console.log('Сохранено: reports/kb-thresholds.md');
