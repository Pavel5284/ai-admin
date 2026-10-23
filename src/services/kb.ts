/**
 * База знаний: поиск по эмбеддингам и ответ без выдумок
 * (день 12–13 гайда, раздел 3.4; принцип D-012).
 *
 * Пайплайн: вопрос → эмбеддинг → топ-4 фрагмента из kb_chunks (косинусное
 * расстояние `<=>`) → модель формулирует ответ по фрагментам → проверки:
 *   1. лучший фрагмент ближе порога KB_DIST_MAX;
 *   2. модель ответила `answerable: true` и указала id фрагментов;
 *   3. id — только из реально найденных, source_ids не пуст;
 *   4. каждое число в ответе есть в процитированных фрагментах.
 * Любая проверка не пройдена или ошибка сети → «ответа нет»: бот передаёт
 * вопрос администратору. Модель никогда не отвечает сама по себе.
 */

import 'dotenv/config';
import { z } from 'zod';
import { complete, tryJson } from './llm';
import { pool } from './db';

const EMBED_URL = (process.env.EMBED_BASE_URL ?? process.env.LLM_BASE_URL ?? 'https://api.mistral.ai/v1').replace(/\/$/, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Эмбеддинги из облака. Формат OpenAI /embeddings понимают Mistral и Google AI Studio.
 * Параметр kind оставлен для совместимости: этим моделям приставки не нужны.
 */
export async function embed(texts: string[], _kind: 'passage' | 'query' = 'passage'): Promise<number[][]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(EMBED_URL + '/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + (process.env.EMBED_API_KEY ?? process.env.LLM_API_KEY ?? ''),
      },
      body: JSON.stringify({ model: process.env.EMBED_MODEL ?? 'mistral-embed', input: texts }),
    });
    if (res.ok) {
      const data: any = await res.json();
      return data.data.map((d: any) => d.embedding);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {   // лимит или сбой: ждём и повторяем
      await sleep(1500 * (attempt + 1));
      continue;
    }
    throw new Error('Embeddings ' + res.status + ': ' + (await res.text()));
  }
}

export type KbChunk = { id: number; title: string; text: string; dist: number };

/**
 * Расширение запроса для слабых формулировок. Эмбеддинг «во сколько вы
 * открываетесь?» уводит от фрагмента «Часы работы», хотя ответ в базе есть.
 * Добавляем название темы только когда вопрос об этом явно спрашивает —
 * это не ответ, а подсказка поиску; отвечает по-прежнему модель по фрагментам.
 */
export function expandQuery(question: string): string {
  const t = question.toLowerCase();
  if (/(?:во\s+сколько|до\s+скольки|когда\s+(?:вы\s+)?(?:открыва|закрыва|работа)|открыва|закрыва|часы\s+работы)/iu.test(t)) {
    return question + ' часы работы барбершопа';
  }
  return question;
}

export async function searchKb(question: string, limit = 4): Promise<KbChunk[]> {
  const [vec] = await embed([question], 'query');
  const { rows } = await pool.query(
    'SELECT id, title, text, embedding <=> $1::vector AS dist FROM kb_chunks ORDER BY dist LIMIT $2',
    [JSON.stringify(vec), limit],
  );
  return rows as { id: number; title: string; text: string; dist: number }[];
}

/** Порог отсечения «ответа нет». Калибровка — scripts/kb-threshold.ts → reports/kb-thresholds.md. */
export const distMax = (): number => Number(process.env.KB_DIST_MAX ?? 0.2);

/** Модель возвращает ровно такой JSON; всё остальное — повод ответить отказом. */
export const Answer = z.object({
  answerable: z.boolean(),
  answer: z.string().max(600),
  source_ids: z.array(z.number().int()),
});
export type Answer = z.infer<typeof Answer>;

const SYSTEM = [
  'Ты отвечаешь на вопросы клиентов барбершопа «Борода» по его базе знаний.',
  'Ниже фрагменты базы знаний. Отвечай ТОЛЬКО на их основе:',
  'не добавляй цены, сроки, адреса и детали, которых во фрагментах нет.',
  'Числа (цены, время, длительность) приводи ровно как во фрагментах, не пересчитывай и не округляй.',
  'Если во фрагментах нет ответа на вопрос — поставь answerable=false и верни пустой answer.',
  'Не строй предположений: не знаешь — признаешься, что ответа нет.',
  'Ответ короткий: 1–3 предложения, по-русски, без канцелярита.',
  'Верни ТОЛЬКО JSON ровно с этими полями:',
  '{"answerable": true|false, "answer": "текст|null", "source_ids": [номера id использованных фрагментов]}',
].join('\n');

type Retrieved = { id: number; title: string; text: string; dist: number };
export type KbReply = { answerable: boolean; answer: string; best: Retrieved | null };

const declined = (best: Retrieved | null): KbReply => ({ answerable: false, answer: '', best });

/** Числа из ответа встречаются в процитированных фрагментах? Простой тест по регулярке. */
export function numbersOk(answer: string, cited: Retrieved[]): boolean {
  const nums = answer.match(/\d+/g) ?? [];
  if (!nums.length) return true;                       // «вход со двора» — проверять нечего
  const corpus = cited.map((c) => c.text + ' ' + c.title).join('\n').replace(/\s+/g, '');
  return nums.every((n) => corpus.includes(n));        // пробелы убраны: «2 000» и «2000» равны
}

function buildUser(question: string, chunks: Retrieved[]): string {
  const list = chunks
    .map((c) => `[id ${c.id}] ${c.title}\n${c.text}`)
    .join('\n\n');
  return `Вопрос клиента: ${question}\n\nФрагменты базы знаний:\n${list}`;
}

/**
 * Ответ на вопрос по базе знаний. Главное свойство: не выдумывает.
 * Ответ есть — `answerable: true` и текст, собранный только из фрагментов.
 * Ответа нет, фрагменты мимо или модель сбоит — answerable=false: вызывающая
 * сторона передаёт вопрос администратору.
 */
export async function answerKb(question: string): Promise<KbReply> {
  let chunks: Retrieved[];
  try {
    chunks = await searchKb(question);
  } catch {
    return declined(null);                             // БД или эмбеддинги недоступны — честный отказ
  }
  let best = chunks[0] ?? null;
  // Лучший фрагмент дальше порога: пробуем один раз расширить запрос
  // (например, «во сколько открываетесь» → «часы работы»). Если и это
  // не помогло — вопрос вне базы, модель даже не зовём.
  if (!best || best.dist > distMax()) {
    const expanded = expandQuery(question);
    if (expanded !== question) {
      try {
        const alt = await searchKb(expanded);
        if (alt[0] && (!best || alt[0].dist < best.dist)) {
          chunks = alt;
          best = alt[0];
        }
      } catch {
        // эмбеддинги недоступны — остаётся честный отказ ниже
      }
    }
  }
  if (!best || best.dist > distMax()) return declined(best);

  const raw = await complete({ system: SYSTEM, user: buildUser(question, chunks), maxTokens: 700 }).catch(() => null);
  const parsed = raw ? Answer.safeParse(tryJson(raw)) : null;
  if (!parsed || !parsed.success) return declined(best);          // модель ответила не по схеме — отказ

  const { answerable, answer, source_ids } = parsed.data;
  const cited = chunks.filter((c) => source_ids.includes(c.id));
  if (!answerable || !answer) return declined(best);
  // id чужие или не указаны: ответ не на что опереть — нельзя выпускать.
  if (!cited.length) return declined(best);
  if (!numbersOk(answer, cited)) return declined(best);  // числа выдуманы — ответ целиком отбрасываем
  return { answerable: true, answer: answer.trim(), best };
}
