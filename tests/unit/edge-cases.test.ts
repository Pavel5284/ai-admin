import { it, expect, describe, beforeAll, beforeEach, vi } from 'vitest';
import { step } from '../../src/dialog/machine';
import { newCtx } from '../../src/dialog/states';
import { FIXTURE_SLOTS, useFixtureCatalog } from './fixtures';

// Слоты считает БД, а юнит-тесты не должны зависеть от живой базы.
const { findSlotsMock, nearestSlotsMock } = vi.hoisted(() => ({
  findSlotsMock: vi.fn(),
  nearestSlotsMock: vi.fn(),
}));

vi.mock('../../src/services/slots', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/slots')>();
  return { ...actual, findSlots: findSlotsMock, nearestSlots: nearestSlotsMock };
});

// Реальный вызов LLM в юнит-тестах недопустим: правила справляются сами.
vi.mock('../../src/services/llm', () => ({
  complete: vi.fn(async () => { throw new Error('LLM выключен в тестах'); }),
  tryJson: () => null,
  stats: { llmCalls: 0 },
}));

// База знаний тестовая: ответ выдаёт заглушка, сеть и БД не трогаются.
const { answerKbMock } = vi.hoisted(() => ({ answerKbMock: vi.fn() }));
vi.mock('../../src/services/kb', () => ({ answerKb: answerKbMock }));

const NOW = new Date(2026, 9, 20, 12, 0);   // вторник, 20 октября 2026

const KB_ANSWER = {
  answerable: true,
  answer: 'Мужская стрижка стоит 2000 ₽ и занимает около 60 минут.',
  best: null,
};

beforeAll(() => {
  useFixtureCatalog();
  findSlotsMock.mockImplementation(async (
    _service: string | undefined,
    _date: string | undefined,
    _now: Date,
    opts: { range?: { from: string; to: string }; masterId?: number } = {},
  ) => {
    let slots = FIXTURE_SLOTS;
    if (opts.masterId) slots = slots.filter((s) => s.masterId === opts.masterId);
    if (opts.range) slots = slots.filter((s) => s.time >= opts.range!.from && s.time < opts.range!.to);
    return slots;
  });
  nearestSlotsMock.mockResolvedValue([]);
});

beforeEach(() => {
  answerKbMock.mockReset();
  answerKbMock.mockResolvedValue(KB_ANSWER);   // по умолчанию база отвечает; отдельные тесты переопределяют
});

/** Прогоняет реплики через автомат и собирает всё, что сказал бот. */
async function play(lines: string[]) {
  const ctx = newCtx('test:edge', NOW);
  const said: string[] = [];
  for (const line of lines) {
    const res = await step(ctx, { type: 'user_text', text: line }, NOW);
    said.push(...res.say);
  }
  return { ctx, said: said.join(' ') };
}

describe('нештатные ситуации', () => {
  it('не понял: переспрос, сужение, оператор', async () => {
    const { ctx, said } = await play(['хочу записаться', 'абракадабра', 'что-то', 'ерунда']);
    expect(said).toContain('Не совсем понял услугу');
    expect(said).toContain('Давайте выберем из списка');
    expect(ctx.outcome).toBe('handoff');
  });

  it('молчит: напомнить, повторить, закрыть — слоты сохранить', async () => {
    const ctx = newCtx('test:edge', NOW);
    await step(ctx, { type: 'user_text', text: 'хочу записаться' }, NOW);
    await step(ctx, { type: 'user_text', text: 'стрижка' }, NOW);
    const said: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await step(ctx, { type: 'silence', ms: 8000 }, NOW);
      said.push(...res.say);
    }
    expect(said[0]).toContain('Вы здесь');
    expect(said[2]).toContain('завершаю разговор');
    expect(ctx.outcome).toBe('abandoned');
    expect(ctx.slots.service).toBe('haircut');
  });

  it('перебил: реплика разбирается как обычный ввод', async () => {
    const ctx = newCtx('test:edge', NOW);
    await step(ctx, { type: 'user_text', text: 'хочу записаться' }, NOW);
    await step(ctx, { type: 'barge_in', text: 'стрижка' }, NOW);
    expect(ctx.slots.service).toBe('haircut');
  });

  it('поправил себя: берёт последнюю дату', async () => {
    const { ctx } = await play(['хочу записаться', 'стрижка', 'завтра, нет, в четверг']);
    expect(ctx.slots.date).toBe('2026-10-22');
  });

  it('ответил не на тот вопрос: слот принят, спросили своё', async () => {
    const { ctx } = await play(['хочу записаться', 'стрижка', 'в 18:00']);
    expect(ctx.slots.time).toBe('18:00');
    expect(ctx.state).toBe('ASK_DATE');
  });

  it('вопрос посреди записи: ответ из базы и предложение продолжить', async () => {
    const { ctx, said } = await play(['хочу записаться', 'стрижка', 'сколько стоит стрижка?']);
    expect(said).toContain('2000 ₽');
    expect(said).toMatch(/Продолжим запись|Вернёмся к записи/);
    expect(ctx.state).toBe('RESUME');
    expect(ctx.outcome).toBe('faq_answered');
  });

  it('вопрос посреди записи: после «да» вернулись к вопросу о дате', async () => {
    const { ctx, said } = await play(['хочу записаться', 'стрижка', 'сколько стоит стрижка?', 'да']);
    expect(said).toContain('На какой день');
    expect(ctx.state).toBe('ASK_DATE');
  });

  it('вопрос посреди записи: в базе ответа нет — оператор, потом продолжаем', async () => {
    answerKbMock.mockResolvedValueOnce({ answerable: false, answer: '', best: null });
    const { ctx, said } = await play(['хочу записаться', 'стрижка', 'сколько стоит татуировка?']);
    expect(said).toContain('Уточню у администратора');
    expect(ctx.state).toBe('RESUME');
  });

  it('второй вопрос посреди записи: цель возврата не теряется', async () => {
    answerKbMock.mockResolvedValue({ answerable: true, answer: 'Ответ из базы.', best: null });
    const { ctx, said } = await play(['хочу записаться', 'стрижка', 'сколько стоит?', 'где вы находитесь?']);
    expect(said.match(/Продолжим запись|Вернёмся к записи/g)?.length).toBe(2);
    expect(ctx.resume).toBe('ASK_DATE');
    expect(ctx.state).toBe('RESUME');
  });

  it('передумал: отмена с подтверждением', async () => {
    const { ctx, said } = await play(['хочу записаться', 'стоп', 'да']);
    expect(said).toContain('Отменить запись?');
    expect(ctx.outcome).toBe('cancelled');
    expect(ctx.slots).toEqual({});
  });

  it('агрессия: сразу оператору из любого состояния', async () => {
    const { ctx, said } = await play(['хочу записаться', 'это жалоба, вы ужасны']);
    expect(ctx.outcome).toBe('handoff');
    expect(said).toContain('Передаю вас администратору');
  });

  it('две просьбы в одной реплике: сначала вопрос, потом запись', async () => {
    const { ctx, said } = await play(['хочу записаться на стрижку, сколько стоит стрижка?']);
    expect(said).toContain('2000 ₽');
    expect(ctx.state).toBe('RESUME');
  });

  it('неоднозначная дата: бот уточняет и не заполняет слот', async () => {
    const { ctx, said } = await play(['хочу записаться', 'стрижка', 'на следующей неделе']);
    expect(said).toContain('Уточните, пожалуйста, какой именно день');
    expect(ctx.slots.date).toBeUndefined();
  });

  it('голосовое или фото: просим написать текстом', async () => {
    const ctx = newCtx('test:edge', NOW);
    const res = await step(ctx, { type: 'non_text', kind: 'voice' }, NOW);
    expect(res.say.join(' ')).toContain('только текст');
  });
});
