/**
 * Фикстуры для юнит-тестов.
 *
 * Каталог услуг и мастеров повторяет db/seed.sql: тесты не должны зависеть
 * от живой БД, поэтому словарь подставляется через setCatalog().
 * Слоты тоже подменяются моком (см. tests/unit/dialog.test.ts).
 */

import { setCatalog, type MasterInfo, type ServiceInfo } from '../../src/services/slots';

export const FIXTURE_SERVICES: ServiceInfo[] = [
  {
    id: 1, code: 'haircut', title: 'Мужская стрижка',
    synonyms: ['стрижк', 'стрижечк', 'подстр', 'постр', 'стрич'], durationMin: 60, price: 2000,
  },
  {
    id: 2, code: 'beard', title: 'Оформление бороды',
    synonyms: ['бород', 'усы', 'усов', 'подровн'], durationMin: 30, price: 1200,
  },
  {
    id: 3, code: 'combo', title: 'Стрижка + борода',
    synonyms: ['комплекс', 'обе', 'все вместе'], durationMin: 90, price: 3000,
  },
  {
    id: 4, code: 'kids', title: 'Детская стрижка',
    synonyms: ['детск', 'ребен', 'сын', 'дочк'], durationMin: 45, price: 1500,
  },
  {
    id: 5, code: 'shave', title: 'Королевское бритьё',
    synonyms: ['бритье', 'побрить', 'бритв'], durationMin: 45, price: 1800,
  },
  {
    id: 6, code: 'styling', title: 'Укладка',
    synonyms: ['укладк', 'уложит'], durationMin: 30, price: 800,
  },
];

export const FIXTURE_MASTERS: MasterInfo[] = [
  { id: 1, name: 'Артём' },
  { id: 2, name: 'Руслан' },
  { id: 3, name: 'Диана' },
];

/** Сетка свободных окон 10:00–20:00 с шагом 30 минут — как заглушка дня 8. */
export const FIXTURE_SLOTS = (() => {
  const slots: { time: string; masterId: number; masterName: string }[] = [];
  for (let minutes = 10 * 60; minutes < 20 * 60; minutes += 30) {
    const h = String(Math.floor(minutes / 60)).padStart(2, '0');
    const m = String(minutes % 60).padStart(2, '0');
    const master = FIXTURE_MASTERS[(minutes / 30) % FIXTURE_MASTERS.length]!;
    slots.push({ time: `${h}:${m}`, masterId: master.id, masterName: master.name });
  }
  return slots;
})();

export function useFixtureCatalog(): void {
  setCatalog(FIXTURE_SERVICES, FIXTURE_MASTERS);
}
