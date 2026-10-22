/**
 * Telegram-канал (день 14 гайда, раздел 3.5).
 *
 * Тонкий адаптер: всё понимание и решение — в автомате через `handleEvent`
 * (D-015), здесь только приём сообщений и отправка реплик. Очередь «сообщение
 * за сообщением» на одну сессию уже внутри `handleEvent` — гонок нет.
 * Порядок обработчиков важен: текст раньше общего, поэтому общий ловит
 * только нетекстовые сообщения.
 */

import 'dotenv/config';
import { Bot } from 'grammy';
import { handleEvent } from '../index';
import type { BotEvent } from '../dialog/states';
import { R } from '../dialog/replies';
import { startSilenceWorker } from '../services/silence';
import { startOutboxWorker } from '../services/outbox';

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN не задан в .env — запуск невозможен');
  process.exit(1);
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

/** Отправляет в автомат событие и возвращает все реплики куда следует. */
async function send(chatId: number, ev: BotEvent): Promise<void> {
  const say = await handleEvent('tg:' + chatId, ev);
  for (const s of say) await bot.api.sendMessage(chatId, s);
}

bot.command('start', (ctx) =>
  ctx.reply('Привет! Я бот-администратор барбершопа «Борода». Это демо, все данные вымышлены. Напишите, на что хотите записаться.'));

bot.on('message:text', async (ctx) => {
  try {
    await send(ctx.chat.id, { type: 'user_text', text: ctx.message.text });
  } catch (e) {
    console.error('telegram:', (e as Error).message);
    await ctx.reply('Что-то сломалось у меня, попробуйте ещё раз через минуту.');
  }
});

// Нетекстовые: реакция бота одинаковая на всех каналах и попадает в лог.
bot.on('message:voice', (ctx) => { void send(ctx.chat.id, { type: 'non_text', kind: 'voice' }).catch(logErr); });
bot.on('message:photo', (ctx) => { void send(ctx.chat.id, { type: 'non_text', kind: 'photo' }).catch(logErr); });
bot.on('message:sticker', (ctx) => { void send(ctx.chat.id, { type: 'non_text', kind: 'sticker' }).catch(logErr); });

// Всё остальное (документы, видео, контакты) — просим текстом.
bot.on('message', (ctx) => { void ctx.reply(R.nonText[0]); });

function logErr(e: unknown): void {
  console.error('telegram:', (e as Error).message);
}

bot.catch((err) => console.error('telegram error:', err.message));

bot.start();
startSilenceWorker();   // помнит неактивных клиентов (15 минут → «Вы здесь?»)
startOutboxWorker();    // досылает недоставленные заявки в CRM (D-010)
console.log('Бот запущен');
