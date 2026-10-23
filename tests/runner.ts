/**
 * Прогон тестовых диалогов (дни 15–16 гайда, раздел 4.1).
 *
 * Каждый сценарий — YAML в tests/dialogs. Раннер:
 *   1. приводит записи в БД к фиксированному состоянию из tests/fixtures;
 *   2. прогоняет реплики через ту же точку входа, что Telegram и консоль;
 *   3. проверяет состояние, слоты, ответы и итоговую запись;
 *   4. считает метрики и пишет reports/latest.md + reports/history.csv.
 *
 * Запуск:
 *   npm run eval                 # dev-сценарии
 *   npm run eval -- holdout      # только holdout
 *   npm run eval -- all          # всё
 *   npm run eval -- dev 001       # фильтр по id или тегу (для отладки)
 */

import 'dotenv/config';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { handleEvent } from '../src/index';
import { loadCtx } from '../src/services/sessions';
import { loadCatalog } from '../src/services/slots';
import { stats } from '../src/services/llm';
import { pool } from '../src/services/db';
import type { BotEvent, Ctx } from '../src/dialog/states';

type Expect = {
  state?: string;
  outcome?: string;
  slots?: Record<string, unknown>;
  say_contains?: string | string[];
  say_not_contains?: string | string[];
};

type Turn = {
  user?: string;
  silence?: number;
  barge_in?: string;
  non_text?: 'voice' | 'photo' | 'sticker';
  /** SQL перед репликой: например, занять слот «в последний момент». */
  sql?: string;
  expect?: Expect;
};

type Existing = {
  phone: string;
  status?: 'confirmed' | 'cancelled';
  date?: string;
  time?: string;
};

type Scenario = {
  id: string;
  title: string;
  tags?: string[];
  split?: 'dev' | 'holdout';
  /** Переменные окружения только на время сценария: сбой CRM или LLM. */
  env?: Record<string, string>;
  /** SQL после фикстуры и до первой реплики (дополнительные записи клиента). */
  setup?: string;
  now: string;
  turns: Turn[];
  final?: {
    outcome?: string;
    booking?: Record<string, string> | 'none';
    existing?: Existing;
    outbox?: 'lead' | 'task';
  };
};

type CreatedBooking = {
  id: number;
  status: string;
  service: string;
  date: string;
  time: string;
  phone: string;
};

const toEvent = (t: Turn): BotEvent => {
  if (t.silence != null) return { type: 'silence', ms: t.silence };
  if (t.barge_in != null) return { type: 'barge_in', text: String(t.barge_in) };
  if (t.non_text != null) return { type: 'non_text', kind: t.non_text };
  return { type: 'user_text', text: String(t.user ?? '') };
};

const asList = (v: string | string[] | undefined): string[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

const lower = (s: string) => s.toLowerCase();

function checkSay(say: string, e: Expect): string[] {
  const out: string[] = [];
  const text = lower(say);
  for (const needle of asList(e.say_contains)) {
    if (!text.includes(lower(needle))) out.push(`в ответе нет «${needle}». Ответ: ${say || '(пусто)'}`);
  }
  for (const needle of asList(e.say_not_contains)) {
    if (text.includes(lower(needle))) out.push(`в ответе не должно быть «${needle}». Ответ: ${say}`);
  }
  return out;
}

function sameFields(row: Record<string, unknown> | undefined, want: Record<string, string>): boolean {
  if (!row) return false;
  return Object.entries(want).every(([k, v]) => row[k] === v);
}

const splitArg = process.argv[2] ?? 'dev';
const filter = process.argv[3];
const fixtureSql = await readFile('tests/fixtures/eval-bookings.sql', 'utf8');

const files = (await readdir('tests/dialogs')).filter((f) => f.endsWith('.yaml')).sort();
const all: Scenario[] = [];
for (const f of files) all.push(parse(await readFile('tests/dialogs/' + f, 'utf8')) as Scenario);

const selected = all.filter((s) => {
  if (splitArg !== 'all' && (s.split ?? 'dev') !== splitArg) return false;
  if (!filter) return true;
  return s.id.includes(filter) || (s.tags ?? []).includes(filter);
});

if (!selected.length) {
  console.error(`Нет сценариев: split=${splitArg}, фильтр=${filter ?? 'нет'}.`);
  await pool.end();
  process.exit(1);
}

try {
  await pool.query('SELECT 1');
} catch (e) {
  console.error('Нет подключения к PostgreSQL. Запустите: docker compose up -d db');
  console.error((e as Error).message);
  await pool.end();
  process.exit(1);
}

await loadCatalog();

type Result = {
  id: string;
  title: string;
  tags: string[];
  ok: boolean;
  failures: string[];
  falseBooking: boolean;
  outcome?: string;
  turns: number;
  llmTurns: number;
};

const results: Result[] = [];
const latencies: number[] = [];
const latenciesLlm: number[] = [];
const latenciesRules: number[] = [];
const slotStat: Record<string, { ok: number; total: number }> = {};
let llmTurns = 0;
let totalTurns = 0;
let bookingTurns = 0;
let bookedScenarios = 0;

for (const s of selected) {
  const sessionId = 'eval:' + s.id;
  const failures: string[] = [];
  const now = new Date(s.now);
  const savedEnv = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(s.env ?? {})) {
    savedEnv.set(k, process.env[k]);
    process.env[k] = v;
  }

  await pool.query('DELETE FROM sessions WHERE session_id = $1', [sessionId]);
  await pool.query('DELETE FROM dialog_log WHERE session_id = $1', [sessionId]);
  await pool.query('DELETE FROM crm_outbox');
  await pool.query(fixtureSql);
  if (s.setup) await pool.query(s.setup);

  let scenarioLlmTurns = 0;

  for (const [i, t] of s.turns.entries()) {
    if (t.sql) await pool.query(t.sql);
    const before = stats.llmCalls;
    const t0 = Date.now();
    const sayArr = await handleEvent(sessionId, toEvent(t), now);
    const say = sayArr.join(' ');
    const latency = Date.now() - t0;
    latencies.push(latency);
    totalTurns++;
    if (stats.llmCalls > before) {
      llmTurns++;
      scenarioLlmTurns++;
      latenciesLlm.push(latency);
    } else {
      latenciesRules.push(latency);
    }

    const e = t.expect;
    if (!e) continue;
    const ctx = await loadCtx(sessionId);

    if (e.state && ctx?.state !== e.state) {
      failures.push(`реплика ${i + 1}: состояние ${ctx?.state}, ожидали ${e.state}`);
    }
    if (e.outcome && ctx?.outcome !== e.outcome) {
      failures.push(`реплика ${i + 1}: исход ${ctx?.outcome}, ожидали ${e.outcome}`);
    }
    for (const [k, v] of Object.entries(e.slots ?? {})) {
      const got = (ctx?.slots as Record<string, unknown> | undefined)?.[k];
      // null в ожидании означает «слота нет»: в Ctx очищенный слот — undefined.
      const ok = v === null ? got == null : JSON.stringify(got) === JSON.stringify(v);
      (slotStat[k] ??= { ok: 0, total: 0 }).total++;
      if (ok) slotStat[k].ok++;
      else failures.push(`реплика ${i + 1}: слот ${k} = ${JSON.stringify(got)}, ожидали ${JSON.stringify(v)}`);
    }
    failures.push(...checkSay(say, e).map((f) => `реплика ${i + 1}: ${f}`));
  }

  // Итог: состояние сессии, созданные ботом записи и изменения в фикстуре.
  const ctx = await loadCtx(sessionId);
  const { rows: created } = await pool.query<CreatedBooking>(
    `SELECT b.id, b.status, s.code AS service,
            to_char(b.starts_at, 'YYYY-MM-DD') AS date,
            to_char(b.starts_at, 'HH24:MI') AS time,
            b.client_phone AS phone
       FROM bookings b JOIN services s ON s.id = b.service_id
      WHERE b.client_phone NOT LIKE '+791600000%'
      ORDER BY b.id`,
  );

  const want = s.final?.booking && s.final.booking !== 'none' ? s.final.booking : null;
  const matched = want ? created.filter((r) => sameFields(r as unknown as Record<string, unknown>, want)) : [];
  let falseBooking = false;

  if (want) {
    if (!matched.length) failures.push('запись не создана: ожидали ' + JSON.stringify(want));
    if (created.length > 1) {
      falseBooking = true;
      failures.push('ЛОЖНЫЕ ЗАПИСИ: ' + JSON.stringify(created));
    }
  } else if (created.length > 0) {
    falseBooking = true;
    failures.push('ЛОЖНАЯ ЗАПИСЬ: ' + JSON.stringify(created));
  }

  if (s.final?.outcome && ctx?.outcome !== s.final.outcome) {
    failures.push(`исход ${ctx?.outcome}, ожидали ${s.final.outcome}`);
  }

  if (s.final?.existing) {
    const e = s.final.existing;
    const { rows } = await pool.query<CreatedBooking>(
      `SELECT b.id, b.status, s.code AS service,
              to_char(b.starts_at, 'YYYY-MM-DD') AS date,
              to_char(b.starts_at, 'HH24:MI') AS time,
              b.client_phone AS phone
         FROM bookings b JOIN services s ON s.id = b.service_id
        WHERE b.client_phone = $1
        ORDER BY b.id`,
      [e.phone],
    );
    const row = rows.find((r) => (!e.status || r.status === e.status)
      && (!e.date || r.date === e.date)
      && (!e.time || r.time === e.time));
    if (!row) {
      failures.push(`запись ${e.phone} не найдена с ожидаемыми полями: ${JSON.stringify(e)}. Есть: ${JSON.stringify(rows)}`);
    }
  }

  if (s.final?.outbox) {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM crm_outbox
        WHERE NOT done AND payload->>'kind' = $1`,
      [s.final.outbox],
    );
    if (!rows[0]?.n) failures.push(`в crm_outbox нет недоставленной заявки kind=${s.final.outbox}`);
  }

  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  if (s.final?.outcome === 'booked') {
    bookedScenarios++;
    bookingTurns += s.turns.length;
  }

  results.push({
    id: s.id, title: s.title, tags: s.tags ?? [], ok: failures.length === 0,
    failures, falseBooking, outcome: ctx?.outcome, turns: s.turns.length, llmTurns: scenarioLlmTurns,
  });
  process.stdout.write(failures.length === 0 ? '.' : 'F');
}

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
const pctile = (arr: number[], p: number) =>
  [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] ?? 0;

const passed = results.filter((r) => r.ok).length;
// Передача оператору — это и handoff, и честный отказ RAG: в обоих случаях
// создаётся задача администратору (см. actions.ts).
const handoffResults = results.filter((r) => r.outcome === 'handoff' || r.outcome === 'faq_declined');
const handoffs = handoffResults.length;
const handoffsJustified = handoffResults.filter((r) => r.tags.includes('handoff-justified')).length;
const handoffsUnnecessary = handoffs - handoffsJustified;
const faqDeclined = results.filter((r) => r.outcome === 'faq_declined').length;
const noAnswer = results.filter((r) => r.tags.includes('no-answer'));
const hallucinated = noAnswer.filter((r) => r.outcome === 'faq_answered').length;
const falseCount = results.filter((r) => r.falseBooking).length;
const tags = [...new Set(results.flatMap((r) => r.tags))].sort();

const lines = [
  `# Отчёт eval (${splitArg}), ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
  '',
  '| Метрика | Значение |',
  '|---|---|',
  `| Сценариев | ${results.length} |`,
  `| Task success | ${pct(passed, results.length)}% (${passed}/${results.length}) |`,
  `| False-booking | ${falseCount} |`,
  `| Handoff rate | ${pct(handoffs, results.length)}% (${handoffs}) |`,
  `| Handoff оправданный / лишний | ${handoffsJustified} / ${handoffsUnnecessary} |`,
  `| Hallucination rate (RAG) | ${pct(hallucinated, noAnswer.length)}% (${hallucinated}/${noAnswer.length} вопросов без ответа) |`,
  `| FAQ без ответа | ${faqDeclined} |`,
  `| LLM share | ${pct(llmTurns, totalTurns)}% (${llmTurns}/${totalTurns} реплик) |`,
  `| Latency p50 / p95 (все) | ${pctile(latencies, 0.5)} / ${pctile(latencies, 0.95)} мс |`,
  `| Latency p50 / p95 (с LLM) | ${pctile(latenciesLlm, 0.5)} / ${pctile(latenciesLlm, 0.95)} мс (${latenciesLlm.length} реплик) |`,
  `| Latency p50 / p95 (правила) | ${pctile(latenciesRules, 0.5)} / ${pctile(latenciesRules, 0.95)} мс (${latenciesRules.length} реплик) |`,
  `| Turns to booking | ${bookedScenarios ? (bookingTurns / bookedScenarios).toFixed(1) : '—'} |`,
  ...Object.entries(slotStat).map(([k, v]) => `| Slot accuracy: ${k} | ${pct(v.ok, v.total)}% (${v.ok}/${v.total}) |`),
  '',
  '## По категориям',
  '',
  '| Тег | Сценариев | Успех |',
  '|---|---|---|',
  ...tags.map((tg) => {
    const rs = results.filter((r) => r.tags.includes(tg));
    return `| ${tg} | ${rs.length} | ${pct(rs.filter((r) => r.ok).length, rs.length)}% |`;
  }),
  '',
  '## Упавшие сценарии',
  '',
  ...(results.filter((r) => !r.ok).length
    ? results.filter((r) => !r.ok).flatMap((r) => [`### ${r.id}: ${r.title}`, ...r.failures.map((f) => '- ' + f), ''])
    : ['Все сценарии прошли.']),
];

await mkdir('reports', { recursive: true });
await writeFile('reports/latest.md', lines.join('\n'));

const history = 'reports/history.csv';
try {
  await readFile(history);
} catch {
  await writeFile(history, 'ts,split,scenarios,task_success,false_bookings,handoff_rate,llm_share,turns_to_booking\n');
}
await appendFile(history, [
  new Date().toISOString(), splitArg, results.length, pct(passed, results.length), falseCount,
  pct(handoffs, results.length), pct(llmTurns, totalTurns),
  bookedScenarios ? (bookingTurns / bookedScenarios).toFixed(1) : '',
].join(',') + '\n');

console.log('\n' + lines.slice(0, 14).join('\n'));
console.log(`\nОтчёт: reports/latest.md, история: ${history}`);
console.log(`Упало сценариев: ${results.length - passed}; ложных записей: ${falseCount}`);

await pool.end();
process.exitCode = falseCount > 0 ? 1 : 0;
