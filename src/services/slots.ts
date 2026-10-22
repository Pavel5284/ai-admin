/**
 * Слоты, записи и каталог услуг.
 *
 * День 8 гайда (раздел 3.1). До этого здесь была заглушка с тремя
 * фиксированными окнами. Теперь:
 *
 *   - источник истины — PostgreSQL: свободные окна считает БД
 *     (запрос лежит в db/queries/free_slots.sql);
 *   - словарь услуг лежит в services.synonyms и грузится в память при старте
 *     (D-013: копия списка в коде больше не нужна);
 *   - имена мастеров приезжают из таблицы masters (D-021);
 *   - «сейчас» всегда передаётся параметром: иначе сценарии с фиксированной
 *     датой давали бы разные слоты в разные дни.
 *
 * Таймзона задана на уровне соединения (db.ts, D-006), поэтому локальное
 * время 'YYYY-MM-DD HH:mm' Postgres сам переведёт в нужный пояс.
 */

import { pool } from './db';
import type { BookingRef, Slots } from '../dialog/states';

export type ServiceInfo = {
  id: number;
  code: string;
  title: string;
  synonyms: string[];
  durationMin: number;
  price: number;
};

export type MasterInfo = { id: number; name: string };

export type FreeSlot = { time: string; masterId: number; masterName: string };

export type Booking = BookingRef & {
  serviceId: number;
  clientPhone: string;
  clientName: string | null;
  status: string;
};

/* ------------------------------------------------------------------ */
/* Каталог: услуги и мастера                                           */
/* ------------------------------------------------------------------ */

let services: ServiceInfo[] = [];
let masters: MasterInfo[] = [];

/** Загружает каталог из БД. Вызывается один раз при старте приложения. */
export async function loadCatalog(): Promise<void> {
  const [svc, mst] = await Promise.all([
    pool.query(
      `SELECT id, code, title, synonyms, duration_min, price
         FROM services ORDER BY id`,
    ),
    pool.query(
      `SELECT id, name FROM masters WHERE active ORDER BY id`,
    ),
  ]);

  services = svc.rows.map((r: any) => ({
    id: r.id as number,
    code: r.code as string,
    title: r.title as string,
    synonyms: (r.synonyms ?? []) as string[],
    durationMin: r.duration_min as number,
    price: r.price as number,
  }));
  masters = mst.rows.map((r: any) => ({ id: r.id as number, name: r.name as string }));
}

/** Подстановка каталога в тестах: тесты не должны зависеть от живой БД. */
export function setCatalog(svc: ServiceInfo[], mst: MasterInfo[]): void {
  services = svc;
  masters = mst;
}

export const allServices = (): ServiceInfo[] => services;
export const allMasters = (): MasterInfo[] => masters;
export const serviceByCode = (code?: string): ServiceInfo | undefined =>
  code ? services.find((s) => s.code === code) : undefined;
export const masterById = (id?: number): MasterInfo | undefined =>
  id === undefined ? undefined : masters.find((m) => m.id === id);
export const serviceTitle = (code?: string): string | undefined => serviceByCode(code)?.title;

/** Основа слова: первые пять букв. «стрижка» → «стриж», «усы» → «усы». */
export const stem = (word: string): string => (word.length > 5 ? word.slice(0, 5) : word);

/**
 * Слово и синоним считаются одним и тем же, если:
 *   - совпадают буква в букву;
 *   - либо одно начинается с другого, и оба не короче четырёх букв.
 * Короткие совпадения не ищем: иначе предлог «к» попал бы в «комплекс»,
 * а «после обеда» — в «стрижка + борода».
 * Многословные синонимы ищем как фразу целиком.
 */
const sameWord = (word: string, synonym: string, text: string): boolean => {
  const s = synonym.toLowerCase();
  if (!s) return false;
  if (/\s/.test(s)) return text.includes(s);
  const w = word.toLowerCase();
  if (w === s) return true;
  if (w.length < 4 || s.length < 4) return false;
  return w.startsWith(s) || s.startsWith(w);
};

/**
 * Услуга по реплике: ищем основы слов в синонимах из БД.
 * Если попали и стрижка, и борода — это «стрижка + борода».
 * Из нескольких совпадений берём самое специфичное — с самым коротким синонимом
 * («детская стрижка» → детская, а не мужская).
 */
export function matchService(text: string): string | undefined {
  const words = text.split(/[^\p{L}\d]+/u).filter(Boolean);
  const hits = new Map<string, { score: number; position: number }>();

  for (const service of services) {
    service.synonyms.forEach((synonym, position) => {
      for (const word of words) {
        if (!sameWord(stem(word), synonym, text.toLowerCase())) continue;
        const score = synonym.length;
        const prev = hits.get(service.code);
        if (!prev || score < prev.score || (score === prev.score && position < prev.position)) {
          hits.set(service.code, { score, position });
        }
      }
    });
  }

  if (hits.has('combo')) return 'combo';
  if (hits.has('haircut') && hits.has('beard')) return 'combo';
  if (!hits.size) return undefined;

  let best: string | undefined;
  let bestScore = Infinity;
  let bestPosition = Infinity;
  for (const [code, hit] of hits) {
    if (hit.score < bestScore || (hit.score === bestScore && hit.position < bestPosition)) {
      best = code;
      bestScore = hit.score;
      bestPosition = hit.position;
    }
  }
  return best;
}

/**
 * Мастер по имени: «к Артёму», «к артем», «к Диане» — по полному имени
 * или по его началу. Начало берём короче, чем у услуг: имена мастеров
 * короче синонимов, а «Диана» в реплике стоит как «к Диане».
 */
export function matchMaster(text: string): MasterInfo | undefined {
  const t = text.toLowerCase();
  for (const m of masters) {
    // Имя из БД может содержать «ё» («Артём»), а текст уже нормализован в «е».
    const name = m.name.toLowerCase().replace(/ё/g, 'е');
    if (t.includes(name)) return m;
    if (name.length >= 4 && t.includes(name.slice(0, 4))) return m;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Свободные окна                                                       */
/* ------------------------------------------------------------------ */

/**
 * Свободные окна на дату. Сетка времени строится по графику мастеров,
 * занятые интервалы вычитаются. $3 — текущее время, а не now(),
 * иначе сценарии с фиксированной датой были бы недетерминированы.
 */
const FREE_SLOTS_SQL = `
SELECT m.id AS master_id, m.name, to_char(s.slot_start, 'HH24:MI') AS slot_time
FROM services sv
JOIN master_services ms ON ms.service_id = sv.id
JOIN masters m          ON m.id = ms.master_id AND m.active
JOIN work_schedule ws   ON ws.master_id = m.id
                       AND ws.weekday = EXTRACT(ISODOW FROM $2::date)
CROSS JOIN LATERAL generate_series(
  $2::date + ws.start_time,
  $2::date + ws.end_time - make_interval(mins => sv.duration_min),
  interval '30 minutes'
) AS s(slot_start)
WHERE sv.code = $1
  AND s.slot_start > $3::timestamptz
  AND ($4::int IS NULL OR m.id = $4)
  AND NOT EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.master_id = m.id AND b.status = 'confirmed'
      AND tstzrange(b.starts_at, b.ends_at)
          && tstzrange(s.slot_start, s.slot_start + make_interval(mins => sv.duration_min))
  )
ORDER BY s.slot_start, m.id
`;

export type SlotQuery = {
  range?: { from: string; to: string };
  masterId?: number;
};

export async function findSlots(
  serviceCode: string | undefined,
  date: string | undefined,
  now: Date,
  opts: SlotQuery = {},
): Promise<FreeSlot[]> {
  if (!serviceCode || !date) return [];
  const { rows } = await pool.query(FREE_SLOTS_SQL, [
    serviceCode,
    date,
    now.toISOString(),
    opts.masterId ?? null,
  ]);
  let slots: FreeSlot[] = rows.map((r: any) => ({
    time: r.slot_time as string,
    masterId: r.master_id as number,
    masterName: r.name as string,
  }));
  if (opts.range) slots = slots.filter((s) => s.time >= opts.range!.from && s.time < opts.range!.to);
  return slots;
}

const addDays = (date: string, n: number): string => {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
};

/** Ближайшие дни со свободными окнами — если нужный день занят. */
export async function nearestSlots(
  serviceCode: string | undefined,
  fromDate: string,
  now: Date,
  days = 7,
  limit = 3,
): Promise<{ date: string; slots: FreeSlot[] }[]> {
  const out: { date: string; slots: FreeSlot[] }[] = [];
  for (let i = 0; i < days && out.length < limit; i++) {
    const date = addDays(fromDate, i);
    const slots = await findSlots(serviceCode, date, now);
    if (slots.length) out.push({ date, slots: slots.slice(0, 3) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Записи                                                               */
/* ------------------------------------------------------------------ */

/** Мастер, у которого нужное время свободно. */
async function findFreeMaster(
  serviceId: number,
  date: string,
  time: string,
  durationMin: number,
): Promise<number | null> {
  // Дата и время целиком идут отдельным параметром: время и отметка не могут
  // жить в одном $N — планировщик резолвит тип параметра по первому
  // употреблению ($3::time), и следующее $3::timestamptz падает с 42846.
  const startsAt = `${date} ${time}:00`;
  const { rows } = await pool.query(
    `SELECT m.id
       FROM masters m
       JOIN master_services ms ON ms.master_id = m.id AND ms.service_id = $1
       JOIN work_schedule ws   ON ws.master_id = m.id
                              AND ws.weekday = EXTRACT(ISODOW FROM $2::date)
      WHERE m.active
        AND $3::time >= ws.start_time
        AND $3::time + make_interval(mins => $4) <= ws.end_time
        AND NOT EXISTS (
          SELECT 1 FROM bookings b
          WHERE b.master_id = m.id AND b.status = 'confirmed'
            AND tstzrange(b.starts_at, b.ends_at)
                && tstzrange($5::timestamptz, $5::timestamptz + make_interval(mins => $4))
        )
      ORDER BY m.id
      LIMIT 1`,
    [serviceId, date, time, durationMin, startsAt],
  );
  return rows[0]?.id ?? null;
}

/**
 * Создание записи. Последняя линия защиты от двойной записи — сама БД:
 * ограничение EXCLUDE даёт код 23P01, его ловим и отдаём причину.
 */
export async function createBooking(
  slots: Slots,
): Promise<{ ok: true; id: number } | { ok: false; reason: string }> {
  const service = serviceByCode(slots.service);
  if (!service || !slots.date || !slots.time) return { ok: false, reason: 'incomplete' };
  if (!slots.phone) return { ok: false, reason: 'no_phone' };

  const masterId = slots.masterId
    ?? await findFreeMaster(service.id, slots.date, slots.time, service.durationMin);
  if (!masterId) return { ok: false, reason: 'slot_taken' };

  try {
    const { rows } = await pool.query(
      `INSERT INTO bookings (master_id, service_id, starts_at, ends_at, client_name, client_phone)
       VALUES ($1, $2, $3::timestamptz,
               $3::timestamptz + make_interval(mins => $4), $5, $6)
       RETURNING id`,
      [masterId, service.id, `${slots.date} ${slots.time}:00`, service.durationMin,
        slots.name ?? null, slots.phone],
    );
    return { ok: true, id: rows[0].id as number };
  } catch (e) {
    if ((e as { code?: string }).code === '23P01') return { ok: false, reason: 'slot_taken' };
    throw e;
  }
}

/** Записи клиента по телефону — для переноса и отмены. */
export async function findBookingsByPhone(phone: string): Promise<Booking[]> {
  const { rows } = await pool.query(
    `SELECT b.id, b.master_id, m.name AS master_name, b.service_id, s.code AS service_code,
            s.title AS service_title,
            to_char(b.starts_at AT TIME ZONE current_setting('TimeZone'), 'YYYY-MM-DD') AS day,
            to_char(b.starts_at AT TIME ZONE current_setting('TimeZone'), 'HH24:MI') AS slot_time,
            b.client_phone, b.client_name, b.status
       FROM bookings b
       JOIN masters m  ON m.id = b.master_id
       JOIN services s ON s.id = b.service_id
      WHERE b.client_phone = $1 AND b.status = 'confirmed'
      ORDER BY b.starts_at`,
    [phone],
  );
  return rows.map((r: any) => ({
    id: r.id as number,
    masterId: r.master_id as number,
    masterName: r.master_name as string,
    serviceId: r.service_id as number,
    serviceCode: r.service_code as string,
    serviceTitle: r.service_title as string,
    date: r.day as string,
    time: r.slot_time as string,
    clientPhone: r.client_phone as string,
    clientName: r.client_name as string | null,
    status: r.status as string,
  }));
}

/** Отмена записи. */
export async function cancelBooking(id: number): Promise<boolean> {
  const { rows } = await pool.query(
    `UPDATE bookings SET status = 'cancelled'
      WHERE id = $1 AND status = 'confirmed'
      RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

/** Перенос записи на новое время. */
export async function rescheduleBooking(
  id: number,
  date: string,
  time: string,
  durationMin: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const { rows } = await pool.query(
      `UPDATE bookings
          SET starts_at = $2::timestamptz,
              ends_at   = $2::timestamptz + make_interval(mins => $3)
        WHERE id = $1 AND status = 'confirmed'
        RETURNING id`,
      [id, `${date} ${time}:00`, durationMin],
    );
    return rows.length ? { ok: true } : { ok: false, reason: 'not_found' };
  } catch (e) {
    if ((e as { code?: string }).code === '23P01') return { ok: false, reason: 'slot_taken' };
    throw e;
  }
}
