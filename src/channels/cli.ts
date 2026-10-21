import 'dotenv/config';
import readline from 'node:readline/promises';
import { handleEvent } from '../index';
import type { BotEvent } from '../dialog/states';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const sessionId = 'cli:' + Date.now();
console.log('Команды: /silence (клиент молчит), /barge <текст> (перебил), /exit');

while (true) {
  const line = (await rl.question('вы> ')).trim();
  if (line === '/exit') break;
  let ev: BotEvent = { type: 'user_text', text: line };
  if (line === '/silence') ev = { type: 'silence', ms: 8000 };
  if (line.startsWith('/barge ')) ev = { type: 'barge_in', text: line.slice(7) };
  for (const s of await handleEvent(sessionId, ev)) console.log('бот> ' + s);
}
rl.close();
process.exit(0);
