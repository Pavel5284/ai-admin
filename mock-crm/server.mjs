// Мок CRM для локальной разработки. День 9 гайда (раздел 3.2).
// Сервис специально умеет ломаться: CHAOS=0.3 — примерно треть запросов
// падает, зависает или возвращает ошибку.
import http from 'node:http';

const CHAOS = Number(process.env.CHAOS ?? 0);   // 0..1: вероятность «плохого» ответа
const leads = new Map();                        // Idempotency-Key -> заявка
const tasks = [];
let seq = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Режим хаоса: имитируем нестабильную CRM
  const dice = Math.random();
  if (dice < CHAOS * 0.5) return send(res, 503, { error: 'service unavailable' });
  if (dice < CHAOS * 0.8) await sleep(5000);            // зависание: клиент должен упасть по таймауту
  else if (dice < CHAOS) return send(res, 400, { error: 'bad request' });

  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });

  if (req.method === 'POST' && url.pathname === '/leads') {
    const key = req.headers['idempotency-key'];
    if (key && leads.has(key)) return send(res, 200, leads.get(key));   // повтор: тот же ответ
    const body = await readBody(req);
    const lead = { id: 'L' + seq++, ...body, createdAt: new Date().toISOString() };
    if (key) leads.set(key, lead);
    return send(res, 201, lead);
  }
  if (req.method === 'GET' && url.pathname === '/leads') return send(res, 200, [...leads.values()]);

  if (req.method === 'GET' && url.pathname === '/clients') return send(res, 200, null);

  if (req.method === 'POST' && url.pathname === '/tasks') {
    const task = { id: 'T' + seq++, ...(await readBody(req)) };
    tasks.push(task);
    return send(res, 201, task);
  }
  if (req.method === 'GET' && url.pathname === '/tasks') return send(res, 200, tasks);

  send(res, 404, { error: 'not found' });
}).listen(4000, () => console.log('mock-crm on :4000, CHAOS=' + CHAOS));
