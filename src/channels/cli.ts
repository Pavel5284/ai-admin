import 'dotenv/config';
import readline from 'node:readline';
import { handleEvent } from '../index';
import type { BotEvent } from '../dialog/states';
import {startOutboxWorker} from "../services/outbox";

startOutboxWorker();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const sessionId = 'cli:' + Date.now();
console.log('Команды: /silence (клиент молчит), /barge <текст> (перебил), /exit');

/**
 * Читаем реплики через async-итератор readline: он работает и в терминале,
 * и когда ввод подставлен пайпом (например, в демо-скрипте).
 */
for await (const raw of rl) {
  const line = raw.trim();
  if (line === '/exit') break;
  rl.prompt();

  let ev: BotEvent = { type: 'user_text', text: line };
  if (line === '/silence') ev = { type: 'silence', ms: 8000 };
  if (line.startsWith('/barge ')) ev = { type: 'barge_in', text: line.slice(7) };
  for (const s of await handleEvent(sessionId, ev)) console.log('бот> ' + s);
}

rl.close();
process.exit(0);
