/**
 * Создаёт несколько «испорченных» копий чистого сценария (раздел 4.1 гайда).
 * Копии обязательно просмотреть глазами: порча может изменить смысл реплики.
 *
 * Запуск: npx tsx scripts/make-dirty.ts tests/dialogs/001-perfect-booking.yaml 4
 */
import { readFile, writeFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import { corrupt } from './corrupt';

const [file, count = '4'] = process.argv.slice(2);
if (!file) {
  console.error('Укажите файл сценария: npx tsx scripts/make-dirty.ts <file.yaml> [count]');
  process.exit(1);
}

const base = parse(await readFile(file, 'utf8'));

for (let seed = 1; seed <= Number(count); seed++) {
  const copy = structuredClone(base);
  copy.id = base.id + '-dirty' + seed;
  copy.title = base.title + ' (искажённая версия ' + seed + ')';
  copy.tags = [...(base.tags ?? []), 'dirty'];
  copy.turns.forEach((t: { user?: string }, i: number) => {
    if (t.user) t.user = corrupt(t.user, seed * 100 + i);
  });
  const out = file.replace('.yaml', '-dirty' + seed + '.yaml');
  await writeFile(out, stringify(copy));
  console.log(out);
}
