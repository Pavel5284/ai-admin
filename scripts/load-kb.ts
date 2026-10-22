/**
 * Загрузка базы знаний: kb/*.md → таблица kb_chunks (день 12 гайда, раздел 3.4).
 *
 * Каждый раздел `##` — отдельный фрагмент для поиска (один раздел — одна мысль).
 * Эмбеддинги считаются в облаке (модель из EMBED_MODEL), тексты и заголовки
 * сохраняются рядом с вектором: поиск отвечает фрагментами, а не файлом.
 *
 * Запуск: `npm run kb:load`. Нужен ключ EMBED_API_KEY в .env и поднятая БД.
 */

import { readdir, readFile } from 'node:fs/promises';
import { embed } from '../src/services/kb';
import { pool } from '../src/services/db';

const files = (await readdir('kb')).filter((f) => f.endsWith('.md'));
if (!files.length) throw new Error('В kb/ нет файлов .md');

await pool.query('TRUNCATE kb_chunks RESTART IDENTITY');

let total = 0;
for (const file of files) {
  const raw = await readFile('kb/' + file, 'utf8');
  const sections = raw.split(/\n(?=## )/).slice(1);      // каждый раздел ## — отдельный фрагмент
  if (!sections.length) {
    console.warn(file + ': разделов нет, пропуск');
    continue;
  }
  const vectors = await embed(sections, 'passage');
  for (let i = 0; i < sections.length; i++) {
    const [head, ...body] = sections[i].split('\n');
    const text = body.join('\n').trim();
    if (!text) continue;                                 // заголовок без текста искать не по чему
    await pool.query(
      'INSERT INTO kb_chunks (source, title, text, embedding) VALUES ($1, $2, $3, $4::vector)',
      [file, head.replace('## ', ''), text, JSON.stringify(vectors[i])],
    );
    total++;
  }
  console.log(file + ': фрагментов ' + sections.length);
}
console.log('Файлов загружено:', files.length + ', фрагментов: ' + total);
await pool.end();
