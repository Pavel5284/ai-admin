import { it, expect, describe, beforeAll } from 'vitest';
import { matchMaster, matchService, serviceTitle, stem } from '../../src/services/slots';
import { FIXTURE_MASTERS, useFixtureCatalog } from './fixtures';

beforeAll(() => useFixtureCatalog());

describe('основа слова', () => {
  it.each([
    ['стрижка', 'стриж'],
    ['усы', 'усы'],
    ['комплекс', 'компл'],
  ])('%s → %s', (word, expected) => {
    expect(stem(word)).toBe(expected);
  });
});

describe('услуга по реплике', () => {
  it.each([
    ['стрижка', 'haircut'],
    ['хочу стрижку', 'haircut'],
    ['подстричься', 'haircut'],
    ['бороду', 'beard'],
    ['оформить бороду', 'beard'],
    ['детская стрижка', 'kids'],
    ['бритьё', 'shave'],
    ['побриться', 'shave'],
    ['укладка', 'styling'],
    ['стрижка и борода', 'combo'],
    ['комплекс', 'combo'],
  ])('%s → %s', (text, expected) => {
    expect(matchService(text)).toBe(expected);
  });

  it.each([
    ['после обеда', 'время, а не услуга'],
    ['к артему', 'только имя мастера'],
    ['на завтра', 'нет услуги'],
    ['что-то непонятное', 'нет услуги'],
  ])('%s — %s', (text) => {
    expect(matchService(text)).toBeUndefined();
  });

  it('название услуги берётся из БД', () => {
    expect(serviceTitle('haircut')).toBe('Мужская стрижка');
    expect(serviceTitle('kids')).toBe('Детская стрижка');
    expect(serviceTitle('нет-такой')).toBeUndefined();
  });
});

describe('мастер по имени', () => {
  it.each([
    ['к артему', 1],
    ['хочу к артем', 1],
    ['к руслану', 2],
    ['к диане', 3],
  ])('%s → мастер %i', (text, id) => {
    expect(matchMaster(text)?.id).toBe(id);
  });

  it('имя с «ё» совпадает с нормализованным текстом', () => {
    expect(FIXTURE_MASTERS[0]!.name).toBe('Артём');
    expect(matchMaster('к артем')?.name).toBe('Артём');
  });

  it('без имени мастера — undefined', () => {
    expect(matchMaster('хочу стрижку')).toBeUndefined();
  });
});
