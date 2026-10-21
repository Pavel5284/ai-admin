import { it, expect, describe } from 'vitest';
import { parseBareHour, parseTimeRules } from '../../src/nlu/time';
import { normalize } from '../../src/nlu/normalize';

const when = (text: string) => parseTimeRules(normalize(text));

describe('разбор времени', () => {
  it.each([
    ['в 15:30', { time: '15:30' }],
    ['в 15 30', { time: '15:30' }],
    ['в 6 вечера', { time: '18:00' }],
    ['в 3 часа дня', { time: '15:00' }],
    ['в 5', { time: '17:00' }],
    ['в 6 утра', { time: '06:00' }],
    ['в полдень', { time: '12:00' }],
    ['в половине 5', { time: '16:30' }],
    ['в четверть 7', { time: '18:15' }],
    ['без 15 6', { time: '17:45' }],
    ['после обеда', { timeRange: { from: '13:00', to: '17:00' } }],
    ['утром', { timeRange: { from: '10:00', to: '12:00' } }],
    ['вечером', { timeRange: { from: '17:00', to: '21:00' } }],
    ['днем', { timeRange: { from: '13:00', to: '17:00' } }],
  ])('%s', (text, expected) => {
    expect(when(text)).toMatchObject(expected);
  });

  it('«в полдень» не путается с датой', () => {
    expect(when('в полдень').time).toBe('12:00');
  });

  it('последняя поправка побеждает: «в 18:00, нет, в 12:00»', () => {
    expect(when('в 18:00 нет в 12:00').time).toBe('12:00');
  });
});

describe('голое число как час', () => {
  it.each([
    ['18', '18:00'],
    ['9', '21:00'],       // 9 утра невозможно в салоне с 10:00 — это 21:00 по D-007
    ['7', '19:00'],
    ['23', '23:00'],
  ])('%s → %s', (input, expected) => {
    expect(parseBareHour(input)).toBe(expected);
  });

  it.each(['', 'да', '1 2', 'abc', '25'])('«%s» — не час', (input) => {
    expect(parseBareHour(input)).toBeUndefined();
  });
});
