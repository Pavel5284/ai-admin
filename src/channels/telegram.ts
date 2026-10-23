/**
 * Telegram-канал (день 14 гайда, раздел 3.5).
 *
 * Тонкий адаптер: всё понимание и решение — в автомате через `handleEvent`
 * (D-015), здесь только приём сообщений и отправка реплик. Очередь «сообщение
 * за сообщением» на одну сессию уже внутри `handleEvent` — гонок нет.
 * Порядок обработчиков важен: текст раньше общего, поэтому общий ловит
 * только нетекстовые сообщения.
 *
 * Лимит сообщений на пользователя — защита бюджета LLM от скриптов
 * (день 20 гайда): 20 сообщений в минуту по умолчанию, настраивается
 * через TG_RATE_LIMIT и TG_RATE_WINDOW_MS.
 */

import 'dotenv/config';
import { Bot, type Context } from 'grammy';
import { handleEvent } from '../index';
import type { BotEvent } from '../dialog/states';
import { R } from '../dialog/replies';
import { startSilenceWorker } from '../services/silence';
import { startOutboxWorker } from '../services/outbox';
import { RateLimiter } from './rate-limit';

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN не задан в .env — запуск невозможен');
  process.exit(1);
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

const limiter = new RateLimiter({
  max: Number(process.env.TG_RATE_LIMIT ?? 20),
  windowMs: Number(process.env.TG_RATE_WINDOW_MS ?? 60_000),
});

/** true — сообщение можно обрабатывать; false — уже ответили или молча отбросили. */
function checkLimit(ctx: Context): boolean {
  const key = String(ctx.chat?.id ?? 'unknown');
  const verdict = limiter.check(key);
  if (verdict === 'ok') return true;
  if (verdict === 'warn') void ctx.reply(R.rateLimited[0]).catch(logErr);
  return false;
}

/** Отправляет в автомат событие и возвращает все реплики куда следует. */
async function send(chatId: number, ev: BotEvent): Promise<void> {
  const say = await handleEvent('tg:' + chatId, ev);
  for (const s of say) await bot.api.sendMessage(chatId, s);
}

bot.command('start', (ctx) => {
  if (!checkLimit(ctx)) return;
  return ctx.reply(
    'Привет! Я бот-администратор барбершопа «Борода». Это демо: все данные вымышлены, ' +
    'реальные записи не создаются. Напишите, на что хотите записаться, или задайте вопрос. ' +
    'Я умею записывать, переносить и отменять записи, отвечать по базе знаний и передавать сложные случаи администратору.',
  );
});

bot.on('message:text', async (ctx) => {
  if (!checkLimit(ctx)) return;
  try {
    await send(ctx.chat.id, { type: 'user_text', text: ctx.message.text });
  } catch (e) {
    console.error('telegram:', (e as Error).message);
    await ctx.reply('Что-то сломалось у меня, попробуйте ещё раз через минуту.');
  }
});

// Нетекстовые: реакция бота одинаковая на всех каналах и попадает в лог.
bot.on('message:voice', (ctx) => {
  if (!checkLimit(ctx)) return;
  void send(ctx.chat.id, { type: 'non_text', kind: 'voice' }).catch(logErr);
});
bot.on('message:photo', (ctx) => {
  if (!checkLimit(ctx)) return;
  void send(ctx.chat.id, { type: 'non_text', kind: 'photo' }).catch(logErr);
});
bot.on('message:sticker', (ctx) => {
  if (!checkLimit(ctx)) return;
  void send(ctx.chat.id, { type: 'non_text', kind: 'sticker' }).catch(logErr);
});

// Всё остальное (документы, видео, контакты) — просим текстом.
bot.on('message', (ctx) => {
  if (!checkLimit(ctx)) return;
  void ctx.reply(R.nonText[0]).catch(logErr);
});

function logErr(e: unknown): void {
  console.error('telegram:', (e as Error).message);
}

bot.catch((err) => console.error('telegram error:', err.message));

bot.start();
startSilenceWorker();   // помнит неактивных клиентов (15 минут → «Вы здесь?»)
startOutboxWorker();    // досылает недоставленные заявки в CRM (D-010)
console.log('Бот запущен');
