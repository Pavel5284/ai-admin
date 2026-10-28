/**
 * Ответ на светскую реплику. Модель пишет только саму реплику, а код:
 *   - выбирает тип ответа (приветствие, благодарность, волнение, ...);
 *   - проверяет, что в тексте нет цифр, вопросов, услуг, мастеров и обещаний;
 *   - при любом сомнении отдаёт шаблон.
 *
 * Запись здесь не создаётся и не отменяется: smalltalk не имеет права
 * менять исход диалога, только сохраняет состояние и возвращает к вопросу.
 */

import { complete, stats } from '../services/llm';
import { allMasters, allServices } from '../services/slots';
import type { SmalltalkKind } from '../nlu/smalltalk';
import type { Ctx } from './states';

const FALLBACK: Record<SmalltalkKind, string[]> = {
  greeting: [
    'Здравствуйте! Рад вас видеть.',
    'Привет! Хорошо, что написали.',
  ],
  thanks: [
    'Пожалуйста! Рад был помочь.',
    'Не за что, обращайтесь.',
  ],
  how_are_you: [
    'Всё отлично, спасибо! Готов помочь с записью.',
    'У меня всё хорошо. А вы как?',
  ],
  bot: [
    'Да, я бот-администратор. Но записываю по-настоящему — по базе, без выдумок.',
    'Я бот, но решения и запись проверяет код. Так что всё честно.',
  ],
  worry: [
    'Понимаю, перед стрижкой многие волнуются. Мастер всё обсудит с вами заранее.',
    'Не переживайте, всё пройдёт спокойно. Если что-то смущает — скажите мастеру.',
  ],
  positive: [
    'Спасибо, приятно! Стараюсь.',
    'Рад, что вам нравится.',
  ],
  goodbye: [
    'До свидания! Если понадобится — пишите.',
    'Всего доброго! Ждём вас.',
  ],
  apology: [
    'Ничего страшного, всё в порядке.',
    'Да не переживайте, всё нормально.',
  ],
  ack: [
    'Понял вас.',
    'Хорошо, учту.',
  ],
};

const SYSTEM = [
  'Ты — бот-администратор барбершопа «Борода». Ответь на светскую реплику клиента одной короткой фразой.',
  'Правила:',
  '- говори живо, по-русски, без канцелярита;',
  '- не задавай вопрос;',
  '- не называй цены, адреса, даты, время, услуги и имена мастеров;',
  '- не обещай скидок, бесплатных услуг или свободных окон;',
  '- не утверждай, что запись создана;',
  '- если клиент волнуется — поддержи его;',
  '- если спрашивает, бот ли ты — честно скажи, что бот, но решения и запись проверяет код;',
  '- без эмодзи, кавычек и списков.',
].join('\n');

const SERVICE_WORDS = /(стриж|бород|брить|укладк|комплекс|детск)/iu;
const PROMISES = /(скидк|бесплат|гарантир|свободн\p{L}*\s+окн|записал\s+вас|забронировал|точно\s+свобод|дешевл)/iu;
// Прощание уместно только в ответ на «до свидания». Иначе бот как будто
// закрывает диалог, хотя ещё спрашивает дату или телефон.
const FAREWELL = /(до\s+встречи|до\s+свидания|всего\s+доброго|прощайте|до\s+скорой)/iu;

function clean(raw: string, kind: SmalltalkKind): string | null {
  let s = raw.trim()
    .replace(/^[\s"'«»`]+|[\s"'«»`]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!s) return null;
  if (s.length > 220) return null;
  if (s.split(/\s+/).length > 24) return null;
  if (/\d/.test(s)) return null;
  if (/\?/.test(s)) return null;
  if (/(?:https?:|www\.|@)/i.test(s)) return null;
  if (/\p{Extended_Pictographic}/u.test(s)) return null;
  if (SERVICE_WORDS.test(s) || PROMISES.test(s)) return null;

  const lower = s.toLowerCase();
  if (allServices().some((v) => lower.includes(v.title.toLowerCase()))) return null;
  if (allMasters().some((m) => lower.includes(m.name.toLowerCase()))) return null;
  if (kind === 'bot' && !/(бот|робот|программ)/iu.test(s)) return null;
  if (kind !== 'goodbye' && FAREWELL.test(s)) return null;

  // Модель иногда возвращает «Здравствуйте,» — приводим к законченной фразе.
  s = s.replace(/[,:;–—-]+$/u, '').trim();
  if (!/[.!…]$/u.test(s)) s += '.';
  return s;
}

function userPrompt(kind: SmalltalkKind, text: string, ctx: Ctx): string {
  return [
    `Клиент: ${text}`,
    `Тип реплики: ${kind}`,
    `Сейчас бот: ${ctx.lastAsked ?? ctx.state}`,
  ].join('\n');
}

/**
 * Один вызов модели на светскую реплику. Любая ошибка, пустой ответ или
 * подозрительный текст — шаблон: диалог не должен ломаться из-за LLM.
 */
export async function answerSmalltalk(kind: SmalltalkKind, text: string, ctx: Ctx): Promise<string> {
  const n = ctx.history.filter((h) => h.role === 'bot').length;
  const fallback = FALLBACK[kind][n % FALLBACK[kind].length]!;

  if (process.env.LLM_HUMANIZE === '0') return fallback;

  stats.styleCalls = (stats.styleCalls ?? 0) + 1;
  try {
    const raw = await complete({
      system: SYSTEM,
      user: userPrompt(kind, text, ctx),
      // Запас на скрытый reasoning: иначе модель может вернуть пустой content.
      maxTokens: 256,
      jsonMode: false,
      temperature: Number(process.env.LLM_STYLE_TEMPERATURE ?? 0.7),
      reasoningEffort: process.env.LLM_STYLE_REASONING_EFFORT || undefined,
      model: process.env.LLM_STYLE_MODEL || undefined,
      ...(process.env.LLM_STYLE_FAST_FAIL === '0' ? {} : { fastFail: true }),
      ...(Number(process.env.LLM_STYLE_TIMEOUT_MS ?? 0) > 0
        ? { timeoutMs: Number(process.env.LLM_STYLE_TIMEOUT_MS) }
        : {}),
    });
    const cleanText = clean(raw, kind);
    if (cleanText) return cleanText;
  } catch {
    // Ниже — шаблон и счётчик, чтобы отказы были видны в метриках.
  }
  stats.styleFallbacks = (stats.styleFallbacks ?? 0) + 1;
  return fallback;
}
