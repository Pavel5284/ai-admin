// Заглушка: настоящая версия работает с PostgreSQL (раздел 3.1)
export type FreeSlot = { time: string; masterId?: number; masterName?: string };

export async function createBooking(
  _slots: unknown,
): Promise<{ ok: true; id: number } | { ok: false; reason: string }> {
  return { ok: true, id: 1 };
}

/** Заглушка до дня 8: настоящая версия спрашивает свободные окна в БД. */
export async function findFreeSlots(
  _date: string | undefined,
  _service: string | undefined,
): Promise<FreeSlot[]> {
  return [
    { time: '10:00', masterId: 1, masterName: 'Артём' },
    { time: '12:00', masterId: 2, masterName: 'Руслан' },
    { time: '18:00', masterId: 1, masterName: 'Артём' },
  ];
}
