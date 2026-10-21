// Заглушка до дня 8: настоящая версия работает с PostgreSQL (раздел 3.1)
export type FreeSlot = { time: string; masterId?: number; masterName?: string };

export async function createBooking(
  _slots: unknown,
): Promise<{ ok: true; id: number } | { ok: false; reason: string }> {
  return { ok: true, id: 1 };
}

/**
 * Заглушка до дня 8: настоящая версия спрашивает свободные окна в БД.
 * Здесь — сетка рабочего дня с шагом 30 минут, чтобы диалог можно было
 * пройти целиком: любое время в пределах 10:00–20:00 считается свободным.
 */
export async function findFreeSlots(
  _date: string | undefined,
  _service: string | undefined,
): Promise<FreeSlot[]> {
  const masters = [
    { masterId: 1, masterName: 'Артём' },
    { masterId: 2, masterName: 'Руслан' },
    { masterId: 3, masterName: 'Диана' },
  ];
  const slots: FreeSlot[] = [];
  for (let minutes = 10 * 60; minutes < 20 * 60; minutes += 30) {
    const h = String(Math.floor(minutes / 60)).padStart(2, '0');
    const m = String(minutes % 60).padStart(2, '0');
    const master = masters[(minutes / 30) % masters.length]!;
    slots.push({ time: `${h}:${m}`, ...master });
  }
  return slots;
}
