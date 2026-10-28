/**
 * Обёртка над LLM (день 10 гайда, раздел 3.3).
 *
 * Правила диалога решает код, модель только извлекает данные. Благодаря
 * единственной точке входа `complete` модель можно подменить фикстурой в
 * тестах, сменить провайдера одной правкой (формат OpenAI /chat/completions:
 * Mistral, Groq, OpenRouter) и считать число реальных вызовов.
 */

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const BASE_URL = (process.env.LLM_BASE_URL ?? 'https://api.mistral.ai/v1').replace(/\/$/, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Счётчики реальных вызовов модели — попадают в метрики недели 3. */
export const stats = { llmCalls: 0, styleCalls: 0, styleFallbacks: 0 };

type CompleteOpts = {
  system: string;
  user: string;
  maxTokens?: number;
  /** По умолчанию JSON-режим включён: так работает извлечение данных и RAG. */
  jsonMode?: boolean;
  /** Температура только для «живых» ответов; решения остаются при 0. */
  temperature?: number;
  /** Для reasoning-моделей: низкий уровень ускоряет короткую стилевую фразу. */
  reasoningEffort?: string;
  /** Стиль не должен ждать: одна попытка и сразу шаблон. */
  fastFail?: boolean;
  /** Свой таймаут для необязательного вызова. */
  timeoutMs?: number;
  /** Отдельная (обычно более быстрая) модель для стиля. */
  model?: string;
};

async function callModel(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  jsonMode: boolean,
  temperature: number,
  reasoningEffort?: string,
  timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 20000),
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(BASE_URL + '/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + (process.env.LLM_API_KEY ?? ''),
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        // jsonMode сбрасывается автоматически, если провайдер отверг JSON-режим
        ...(jsonMode && process.env.LLM_JSON_MODE === '1' ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function rawComplete(opts: CompleteOpts): Promise<string> {
  const main = process.env.LLM_MODEL;
  const fallback = process.env.LLM_FALLBACK_MODEL;
  // Стиль — необязательный слой: при сбое сразу шаблон, без второй модели и пауз.
  const models = (opts.model ? [opts.model] : opts.fastFail ? [main] : [main, fallback])
    .filter(Boolean) as string[];
  const maxAttempts = opts.fastFail ? 1 : 2;
  let lastError = 'LLM_MODEL не задан в .env';
  let jsonMode = opts.jsonMode ?? true;
  const temperature = opts.temperature ?? 0;
  for (const model of models) {                      // сначала основная модель, потом запасная
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await callModel(
          model, opts.system, opts.user, opts.maxTokens ?? 400, jsonMode,
          temperature, opts.reasoningEffort, opts.timeoutMs,
        );
      } catch (e) {                                  // таймаут или нет сети
        lastError = 'LLM: ' + (e as Error).message;
        continue;
      }
      if (res.ok) {
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        return data.choices?.[0]?.message?.content ?? '';
      }
      lastError = 'LLM ' + res.status + ': ' + (await res.text());
      // Провайдер в JSON-режиме иногда не выдаёт валидный JSON (у мыслительных
      // моделей ещё и токены уходят на reasoning): пробуем без response_format —
      // JSON всё равно достанет tryJson (совет гайда при ошибке 400).
      if (res.status === 400 && jsonMode && lastError.includes('json_validate')) {
        jsonMode = false;
        continue;
      }
      if (res.status !== 429 && res.status < 500) throw new Error(lastError);   // ключ или запрос неверны: повтор не поможет
      if (attempt === 0) await sleep(1500);          // лимит или сбой: ждём и повторяем один раз
    }
    // у каждой модели свой лимит, поэтому дальше пробуем запасную
  }
  throw new Error(lastError);
}

/** Файловый кэш по хэшу промпта: повторный прогон сценариев не тратит деньги. */
async function cached(key: string, make: () => Promise<string>): Promise<string> {
  if (process.env.LLM_CACHE !== '1') return make();
  const file = '.cache/llm/' + createHash('sha256').update(key).digest('hex') + '.txt';
  try { return await readFile(file, 'utf8'); } catch { /* в кэше нет */ }
  const value = await make();
  await mkdir('.cache/llm', { recursive: true });
  await writeFile(file, value);
  return value;
}

export const complete = (opts: CompleteOpts): Promise<string> => {
  stats.llmCalls++;
  return cached(JSON.stringify(opts), () => rawComplete(opts));
};

/** Достаёт первый JSON-объект из ответа, даже если модель обернула его в текст. */
export function tryJson(s: string): unknown {
  const m = s.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}
