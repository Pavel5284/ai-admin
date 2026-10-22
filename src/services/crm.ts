// День 9 гайда (раздел 3.2): настоящий клиент CRM.
// Таймаут, повторы для «временных» сбоев (сеть, 5xx) и Idempotency-Key,
// чтобы повтор после таймаута не создал дубль заявки.

const BASE_URL = process.env.CRM_URL ?? 'http://localhost:4000';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CrmError extends Error {
  constructor(public status: number, public body: string) { super('CRM ' + status + ': ' + body); }
}

// сеть недоступна или сработал таймаут: имеет смысл повторить
const isTransient = (e: unknown) => e instanceof TypeError || (e as Error)?.name === 'AbortError';

async function request<T>(path: string, init: RequestInit = {}, retries = 2, timeoutMs = 3000): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(BASE_URL + path, { ...init, signal: ctrl.signal });
      if (res.ok) return (await res.json()) as T;
      if (res.status >= 500 && attempt < retries) { await sleep(200 * 2 ** attempt); continue; }
      throw new CrmError(res.status, await res.text());      // 4xx: повтор не поможет
    } catch (e) {
      if (isTransient(e) && attempt < retries) { await sleep(200 * 2 ** attempt); continue; }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export const createLead = (lead: { bookingId: number } & Record<string, unknown>) =>
  request<{ id: string }>('/leads', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'Idempotency-Key': 'booking-' + lead.bookingId },
    body: JSON.stringify(lead),
  });

export const createTask = (task: Record<string, unknown>) =>
  request<{ id: string }>('/tasks', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(task) });
