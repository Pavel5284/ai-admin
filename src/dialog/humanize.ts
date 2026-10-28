/**
 * «Живой» слой поверх готового ответа.
 *
 * Код уже решил, что сказать, и собрал точный текст с фактами. Модель может
 * добавить только одну короткую вводную фразу — и ничего больше. Если фраза
 * содержит цифры, вопрос, услугу, мастера или обещание, она отбрасывается:
 * клиент видит исходный шаблон. Так стиль не может изменить смысл, цену,
 * дату, время или факт записи.
 */

import { complete, stats } from '../services/llm';
import { allMasters, allServices } from '../services/slots';
import type { Ctx } from './states';

type HumanizeOpts = {
  ctx: Ctx;
  userText: string;
  say: string[];
  enabled?: boolean;
};

const SYSTEM = [
  'Ты — администратор барбершопа «Борода». К готовому ответу бота добавь одну короткую живую вводную фразу.',
  'Правила:',
  '- только одна фраза, до 12 слов;',
  '- подтверди, что услышал клиента, или поддержи его;',
  '- не задавай вопрос;',
  '- не называй цены, даты, время, адреса, услуги и имена мастеров;',
  '- не обещай скидок, бесплатных услуг, свободных окон или записи;',
  '- не повторяй текст ответа;',
  '- без кавычек, списков и эмодзи;',
  '- всегда верни одну короткую фразу, даже если ответ простой.',
].join('\n');

const SERVICE_WORDS = /(стриж|бород|брить|укладк|комплекс|детск)/iu;
const PROMISES = /(скидк|бесплат|гарантир|свободн\p{L}*\s+окн|записал\s+вас|забронировал|точно\s+свобод|дешевл|цен[аы]|стоимост|руб|₽|адрес)/iu;
const FAREWELL = /(до\s+встречи|до\s+свидания|всего\s+доброго|прощайте|до\s+скорой)/iu;

function temperature(): number {
  const n = Number(process.env.LLM_STYLE_TEMPERATURE ?? 0.7);
  if (!Number.isFinite(n)) return 0.7;
  return Math.max(0, Math.min(1.5, n));
}

function cleanPrefix(raw: string): string | null {
  let s = raw.trim()
    .replace(/^[\s"'«»`]+|[\s"'«»`]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!s) return null;
  if (s.length > 120) return null;
  if (s.split(/\s+/).length > 14) return null;
  if (/\d/.test(s)) return null;
  if (/\?/.test(s)) return null;
  if (/(?:https?:|www\.|@)/i.test(s)) return null;
  if (/\p{Extended_Pictographic}/u.test(s)) return null;
  if (SERVICE_WORDS.test(s) || PROMISES.test(s) || FAREWELL.test(s)) return null;

  const lower = s.toLowerCase();
  if (allServices().some((v) => lower.includes(v.title.toLowerCase()))) return null;
  if (allMasters().some((m) => lower.includes(m.name.toLowerCase()))) return null;

  s = s.replace(/[,:;–—-]+$/u, '').trim();
  if (!/[.!…]$/u.test(s)) s += '.';
  return s;
}

function prompt(userText: string, core: string, ctx: Ctx): string {
  return [
    `Клиент: ${userText}`,
    `Бот сейчас ответит: ${core}`,
    `Состояние: ${ctx.lastAsked ?? ctx.state}`,
  ].join('\n');
}

/** Ответ, который уже написан моделью или требует серьёзного тона, не трогаем. */
function protectedReply(core: string, ctx: Ctx): boolean {
  if (ctx.state === 'HANDOFF' || ctx.outcome === 'handoff' || ctx.outcome === 'faq_declined') return true;
  return /^(Здравствуйте|Передаю вас|Уточню у администратора)/i.test(core);
}

/**
 * Вернуть ответ с короткой вводной фразой. Длина массива не меняется,
 * поэтому история, выбор вариантов и проверки сценариев остаются прежними.
 */
export async function humanize(opts: HumanizeOpts): Promise<string[]> {
  const { ctx, userText, say } = opts;
  if (opts.enabled === false) return say;
  if (process.env.LLM_HUMANIZE === '0') return say;
  if (!userText.trim() || !say.length) return say;

  const core = say[0]!;
  if (!core.trim() || protectedReply(core, ctx)) return say;

  stats.styleCalls = (stats.styleCalls ?? 0) + 1;
  try {
    const raw = await complete({
      system: SYSTEM,
      user: prompt(userText, core, ctx),
      // Запас на скрытый reasoning: у gpt-oss/Qwen при малом лимите content пустой.
      maxTokens: 256,
      jsonMode: false,
      temperature: temperature(),
      reasoningEffort: process.env.LLM_STYLE_REASONING_EFFORT || undefined,
      model: process.env.LLM_STYLE_MODEL || undefined,
      ...(process.env.LLM_STYLE_FAST_FAIL === '0' ? {} : { fastFail: true }),
      ...(Number(process.env.LLM_STYLE_TIMEOUT_MS ?? 0) > 0
        ? { timeoutMs: Number(process.env.LLM_STYLE_TIMEOUT_MS) }
        : {}),
    });
    // Модель иногда повторяет готовый ответ внутри «вводной» фразы. Сначала
    // вырезаем повтор, чтобы знак вопроса из ответа не браковал всю фразу,
    // затем проверяем оставшуюся вводную часть обычными правилами.
    const lowerCore = core.toLowerCase();
    const lowerRaw = raw.toLowerCase();
    let prefix: string | null;
    if (lowerRaw.includes(lowerCore)) {
      const at = lowerRaw.indexOf(lowerCore);
      const before = (raw.slice(0, at) + raw.slice(at + core.length)).trim();
      prefix = cleanPrefix(before);
      if (!prefix) return say;
    } else {
      prefix = cleanPrefix(raw);
      if (!prefix) throw new Error('style rejected');
    }

    const lowerPrefix = prefix.toLowerCase();
    if (lowerCore.startsWith(lowerPrefix) || lowerCore.includes(lowerPrefix)) return say;
    return [prefix + ' ' + core, ...say.slice(1)];
  } catch {
    stats.styleFallbacks = (stats.styleFallbacks ?? 0) + 1;
    return say;
  }
}

/**
 * В `step` бот уже положил сырые реплики в историю. После стилизации заменяем
 * именно последние реплики этого шага, чтобы «повторите» и выбор вариантов
 * видели тот же текст, который ушёл клиенту.
 */
export function replaceLastBotTurns(ctx: Ctx, raw: string[], next: string[]): void {
  if (raw.length !== next.length || !raw.length) return;
  const indexes: number[] = [];
  for (let i = ctx.history.length - 1; i >= 0 && indexes.length < raw.length; i--) {
    if (ctx.history[i]!.role === 'bot') indexes.push(i);
  }
  if (indexes.length !== raw.length) return;
  indexes.reverse();
  for (let i = 0; i < raw.length; i++) {
    const turn = ctx.history[indexes[i]!]!;
    if (turn.text === raw[i]) turn.text = next[i]!;
  }
}
