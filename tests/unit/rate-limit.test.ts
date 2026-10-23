import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/channels/rate-limit';

describe('RateLimiter', () => {
  it('пропускает сообщения в пределах лимита', () => {
    const limiter = new RateLimiter({ max: 3, windowMs: 1000 });
    expect(limiter.check('u', 0)).toBe('ok');
    expect(limiter.check('u', 100)).toBe('ok');
    expect(limiter.check('u', 200)).toBe('ok');
  });

  it('предупреждает один раз, дальше молча отбрасывает', () => {
    const limiter = new RateLimiter({ max: 2, windowMs: 1000 });
    expect(limiter.check('u', 0)).toBe('ok');
    expect(limiter.check('u', 100)).toBe('ok');
    expect(limiter.check('u', 200)).toBe('warn');
    expect(limiter.check('u', 300)).toBe('drop');
  });

  it('считает окно скользящим', () => {
    const limiter = new RateLimiter({ max: 2, windowMs: 1000 });
    expect(limiter.check('u', 100)).toBe('ok');
    expect(limiter.check('u', 900)).toBe('ok');
    expect(limiter.check('u', 950)).toBe('warn');
    // Оба сообщения ещё в окне — по-прежнему нельзя.
    expect(limiter.check('u', 1001)).toBe('drop');
    // Первое сообщение вышло из окна, снова можно.
    expect(limiter.check('u', 1901)).toBe('ok');
  });

  it('держит пользователей отдельно', () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 });
    expect(limiter.check('a', 0)).toBe('ok');
    expect(limiter.check('b', 0)).toBe('ok');
    expect(limiter.check('a', 1)).toBe('warn');
  });

  it('reset очищает окно', () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 });
    expect(limiter.check('u', 0)).toBe('ok');
    expect(limiter.check('u', 1)).toBe('warn');
    limiter.reset('u');
    expect(limiter.check('u', 2)).toBe('ok');
  });
});
