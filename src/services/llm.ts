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

/** Счётчик реальных вызовов модели — попадает в метрики недели 3. */
export const stats = { llmCalls: 0 };

async function callModel(model: string, system: string, user: string, maxTokens: number, jsonMode: boolean): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.LLM_TIMEOUT_MS ?? 20000));
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
        temperature: 0,
        max_tokens: maxTokens,
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

async function rawComplete(opts: { system: string; user: string; maxTokens?: number }): Promise<string> {
  const models = [process.env.LLM_MODEL, process.env.LLM_FALLBACK_MODEL].filter(Boolean) as string[];
  let lastError = 'LLM_MODEL не задан в .env';
  let jsonMode = true;
  for (const model of models) {                      // сначала основная модель, потом запасная
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await callModel(model, opts.system, opts.user, opts.maxTokens ?? 400, jsonMode);
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

export const complete = (opts: { system: string; user: string; maxTokens?: number }): Promise<string> => {
  stats.llmCalls++;
  return cached(JSON.stringify(opts), () => rawComplete(opts));
};

/** Достаёт первый JSON-объект из ответа, даже если модель обернула его в текст. */
export function tryJson(s: string): unknown {
  const m = s.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}
