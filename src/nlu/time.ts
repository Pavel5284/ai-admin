/**
 * Правила разбора времени.
 * На вход приходит уже нормализованный текст: «в 6 вечера», «в 15 30», «без 15 6».
 */

import {afterCorrection, wb} from './normalize';

export type TimeResult = {
  time?: string;                           // 'HH:mm'
  timeRange?: { from: string; to: string };
  ambiguous?: string[];                    // что нужно уточнить у клиента
};

/** Часы работы салона: 10:00–21:00. Всё, что вне, — забота оператора. */
export const WORK_START = 10;
export const WORK_END = 21;

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

/**
 * Час, попавший вне рабочих часов, сдвигаем на 12 часов:
 * «в половине 5» → 4:30 → 16:30, «без 15 6» → 5:45 → 17:45.
 */
const fitToWorkHours = (h: number, m: number): [number, number] => {
  if (h >= WORK_START && h <= WORK_END) return [h, m];
  if (h + 12 <= WORK_END) return [h + 12, m];
  return [h, m];
};

/** «в полдень» → 12:00. */
const NOON = wb(String.raw`в\s+полдень`);
/** «без 15 6» → 5:45. Сначала минуты, потом час. */
const WITHOUT = wb(String.raw`без\s+(\d{1,2})\s+(\d{1,2})`);
/** «в половине 5» → 4:30. */
const HALF = wb(String.raw`(?:в\s+)?половин[аеуы]?\s+(\d{1,2})`);
/** «в четверть 7» → 6:15. */
const QUARTER = wb(String.raw`(?:в\s+)?четверт[ьи]\s+(\d{1,2})`);
/** «в 15:30». Двоеточие — только время, дата пишется через точку. */
const CLOCK = /(?<![\p{L}\d])(\d{1,2})\s*:\s*(\d{2})(?!\d)/u;
/** «в 15 30». */
const SPOKEN_CLOCK = wb(String.raw`в\s+(\d{1,2})\s+(\d{2})(?!\d)`);
/** «в 6 вечера», «в 3 часа дня», «в 10 часов». */
const HOUR = wb(String.raw`в\s+(\d{1,2})(?!\d)\s*(утра|утром|ночи|вечера|вечером|дня|днем|часа|часов|час)?`);

export function parseTimeRules(text: string): TimeResult {
  text = afterCorrection(text);   // «в 18:00, нет, в 12:00» — берём последнее
  const out: TimeResult = {};

  // 0. «в полдень» → 12:00
  if (NOON.test(text)) { out.time = '12:00'; return out; }

  // 1. «без 15 6» → 5:45
  const without = WITHOUT.exec(text);
  if (without) {
    const minutes = Number(without[1]);
    const hour = Number(without[2]);
    if (hour <= 24 && minutes < 60) {
      const total = (hour * 60 - minutes + 24 * 60) % (24 * 60);
      const [h, m] = fitToWorkHours(Math.floor(total / 60), total % 60);
      out.time = hhmm(h, m);
      return out;
    }
  }

  // 2. «в половине 5» → 4:30 → 16:30
  const half = HALF.exec(text);
  if (half) {
    const hour = Number(half[1]);
    if (hour >= 1 && hour <= 24) {
      const [h, m] = fitToWorkHours((hour - 1 + 24) % 24, 30);
      out.time = hhmm(h, m);
      return out;
    }
  }

  // 3. «в четверть 7» → 6:15 → 18:15
  const quarter = QUARTER.exec(text);
  if (quarter) {
    const hour = Number(quarter[1]);
    if (hour >= 1 && hour <= 24) {
      const [h, m] = fitToWorkHours((hour - 1 + 24) % 24, 15);
      out.time = hhmm(h, m);
      return out;
    }
  }

  // 4. «в 15:30»
  const clock = CLOCK.exec(text);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    if (h <= 23 && m <= 59) {
      out.time = hhmm(h, m);
      return out;
    }
  }

  // 5. «в 15 30»
  const spoken = SPOKEN_CLOCK.exec(text);
  if (spoken) {
    const h = Number(spoken[1]);
    const m = Number(spoken[2]);
    if (h <= 23 && m <= 59) {
      out.time = hhmm(h, m);
      return out;
    }
  }

  // 6. «в 6 вечера»
  const hour = HOUR.exec(text);
  if (hour) {
    const h = Number(hour[1]);
    const marker = (hour[2] ?? '').toLowerCase();
    if (h >= 1 && h <= 24) {
      let result = h;
      if (/утр/.test(marker)) result = h === 12 ? 0 : h;          // «в 6 утра»
      else if (/ноч/.test(marker)) result = h === 12 ? 0 : h;     // «в 12 ночи»
      else if (/вечер|дня|днем/.test(marker)) result = h < 12 ? h + 12 : h; // «в 6 вечера»
      else if (h < WORK_START) result = h + 12;                  // «в 5» → 17:00
      if (result <= 23) {
        out.time = hhmm(result, 0);
        // «в 10»: подошли бы оба варианта — спросим. При часах 10–21 такого часа нет,
        // но правило оставьте: смена рабочих часов его включит.
        if (!marker && h >= WORK_START && h + 12 <= WORK_END) out.ambiguous = ['time'];
        return out;
      }
    }
  }

  // 7. Неточное время: это диапазон, а не конкретный час
  if (/после\s+обеда/.test(text)) { out.timeRange = { from: '13:00', to: '17:00' }; return out; }
  if (/утром/.test(text)) { out.timeRange = { from: '10:00', to: '12:00' }; return out; }
  if (/вечером|ближе к вечеру/.test(text)) { out.timeRange = { from: '17:00', to: '21:00' }; return out; }
  if (/днем/.test(text)) { out.timeRange = { from: '13:00', to: '17:00' }; return out; }

  return out;
}
