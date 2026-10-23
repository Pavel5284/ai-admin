/**
 * Простой лимит сообщений на пользователя (день 20 гайда).
 *
 * Telegram — публичный канал: один скрипт может прислать тысячи сообщений
 * и сжечь бюджет LLM. Лимит хранится в памяти процесса: для одного инстанса
 * бота этого достаточно, после перезапуска окно сбрасывается.
 */

export type RateLimitOptions = {
  /** Сколько сообщений разрешено за окно. */
  max: number;
  /** Длина окна в миллисекундах. */
  windowMs: number;
};

export type RateLimitVerdict = 'ok' | 'warn' | 'drop';

/**
 * `warn` — первое превышение в окне: можно один раз ответить «слишком часто».
 * `drop` — повторные сообщения сверх лимита: молча игнорируем, чтобы не
 * удваивать нагрузку ответом на спам.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly warnedAt = new Map<string, number>();

  constructor(private readonly options: RateLimitOptions) {}

  check(key: string, now = Date.now()): RateLimitVerdict {
    const cutoff = now - this.options.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length < this.options.max) {
      recent.push(now);
      this.hits.set(key, recent);
      return 'ok';
    }

    this.hits.set(key, recent);
    const lastWarn = this.warnedAt.get(key);
    if (lastWarn === undefined || now - lastWarn >= this.options.windowMs) {
      this.warnedAt.set(key, now);
      return 'warn';
    }
    return 'drop';
  }

  /** Для тестов и административных сценариев. */
  reset(key?: string): void {
    if (key === undefined) {
      this.hits.clear();
      this.warnedAt.clear();
      return;
    }
    this.hits.delete(key);
    this.warnedAt.delete(key);
  }
}
