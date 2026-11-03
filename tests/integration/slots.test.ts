/**
 * Интеграционные тесты слота: работают с настоящей БД.
 *
 * Если база не поднята — тесты пропускаются, а не падают:
 *   docker compose up -d db && npm test
 */

import { it, expect, describe, beforeAll, afterAll } from 'vitest';
import { pool } from '../../src/services/db';
import {
  cancelBooking, createBooking, findBookingsByPhone, findBookingsByTelegramId,
  findSlots, loadCatalog, rescheduleBooking,
} from '../../src/services/slots';

const NOW = new Date();
const tomorrow = (() => {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 1);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();

const PHONE = '+79000000099';
const TELEGRAM_ID = 9000000001;

// Проверяем базу до описания тестов: skipIf вычисляется на этапе сбора,
// поэтому проверка должна быть синхронной относительно describe.
const dbAvailable = await (async () => {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
})();

beforeAll(async () => {
  if (!dbAvailable) return;
  // Каталог нужен матчингу услуг; сбор его провала покажут сами тесты ниже.
  await loadCatalog().catch(() => undefined);
});

afterAll(async () => {
  await pool.query('DELETE FROM bookings WHERE client_phone = $1', [PHONE]).catch(() => undefined);
  await pool.end().catch(() => undefined);
});

describe.skipIf(!dbAvailable)('слоты в PostgreSQL', () => {
  it('не отдаёт часы, которые только что заняли', async () => {
    const slots = await findSlots('haircut', tomorrow, NOW);
    const slot = slots[0]!;

    const created = await createBooking({
      service: 'haircut', date: tomorrow, time: slot.time,
      masterId: slot.masterId, phone: PHONE,
    });
    expect(created.ok).toBe(true);

    const after = await findSlots('haircut', tomorrow, NOW, { masterId: slot.masterId });
    expect(after.some((s) => s.time === slot.time)).toBe(false);

    if (created.ok) await cancelBooking(created.id);
  });

  it('фильтрует окна по мастеру и по диапазону времени', async () => {
    const only = await findSlots('haircut', tomorrow, NOW, { masterId: 2 });
    expect(only.every((s) => s.masterId === 2)).toBe(true);

    const evening = await findSlots('haircut', tomorrow, NOW, { range: { from: '17:00', to: '21:00' } });
    expect(evening.every((s) => s.time >= '17:00' && s.time < '21:00')).toBe(true);
  });

  it('создаёт запись, находит её по телефону и отменяет', async () => {
    const slots = await findSlots('haircut', tomorrow, NOW);
    const slot = slots[0]!;

    const created = await createBooking({
      service: 'haircut', date: tomorrow, time: slot.time,
      masterId: slot.masterId, phone: PHONE,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const found = await findBookingsByPhone(PHONE);
    expect(found.map((b) => b.id)).toContain(created.id);
    expect(found[0]!.serviceCode).toBe('haircut');

    expect(await cancelBooking(created.id)).toBe(true);
    expect(await findBookingsByPhone(PHONE)).toHaveLength(0);
  });

  it('находит предстоящую запись по Telegram id и проверяет владельца при изменении', async () => {
    const slots = await findSlots('haircut', tomorrow, NOW);
    const slot = slots[0]!;

    const created = await createBooking({
      service: 'haircut', date: tomorrow, time: slot.time,
      masterId: slot.masterId, phone: PHONE,
    }, TELEGRAM_ID);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const found = await findBookingsByTelegramId(TELEGRAM_ID, NOW);
    expect(found.map((b) => b.id)).toContain(created.id);
    expect(found[0]!.clientTelegramId).toBe(TELEGRAM_ID);

    // Чужой Telegram id не может отменить или перенести запись.
    expect(await cancelBooking(created.id, TELEGRAM_ID + 1)).toBe(false);
    expect(await rescheduleBooking(created.id, tomorrow, slot.time, 60, TELEGRAM_ID + 1))
      .toEqual({ ok: false, reason: 'not_found' });

    expect(await cancelBooking(created.id, TELEGRAM_ID)).toBe(true);
    expect(await findBookingsByTelegramId(TELEGRAM_ID, NOW)).toHaveLength(0);
  });

  it('не отдаёт прошедшие записи по Telegram id', async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO bookings (master_id, service_id, starts_at, ends_at,
                             client_name, client_phone, client_telegram_id)
       SELECT m.id, s.id, now() - interval '1 day',
              now() - interval '1 day' + interval '60 minutes',
              'Прошлая', $1, $2
         FROM masters m JOIN services s ON s.code = 'haircut'
        WHERE m.name = 'Артём'
       RETURNING id`,
      [PHONE, TELEGRAM_ID],
    );
    const pastId = rows[0]!.id;

    const found = await findBookingsByTelegramId(TELEGRAM_ID, NOW);
    expect(found.map((b) => b.id)).not.toContain(pastId);

    await pool.query('DELETE FROM bookings WHERE id = $1', [pastId]);
  });

  it('не даёт записать дважды на одно время: ловит занятый слот', async () => {
    const slots = await findSlots('haircut', tomorrow, NOW);
    const slot = slots[0]!;

    const first = await createBooking({
      service: 'haircut', date: tomorrow, time: slot.time,
      masterId: slot.masterId, phone: PHONE,
    });
    expect(first.ok).toBe(true);

    const second = await createBooking({
      service: 'haircut', date: tomorrow, time: slot.time,
      masterId: slot.masterId, phone: '+79000000098',
    });
    expect(second).toEqual({ ok: false, reason: 'slot_taken' });

    if (first.ok) await cancelBooking(first.id);
  });

  it('переносит запись на другое время', async () => {
    const slots = await findSlots('haircut', tomorrow, NOW);
    const slot = slots[0]!;
    const created = await createBooking({
      service: 'haircut', date: tomorrow, time: slot.time,
      masterId: slot.masterId, phone: PHONE,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const other = slots.find((s) => s.time !== slot.time && s.masterId === slot.masterId);
    if (!other) {
      await cancelBooking(created.id);
      return;
    }
    const moved = await rescheduleBooking(created.id, tomorrow, other.time, 60);
    expect(moved.ok).toBe(true);

    const found = await findBookingsByPhone(PHONE);
    expect(found[0]!.time).toBe(other.time);

    await cancelBooking(created.id);
  });
});
