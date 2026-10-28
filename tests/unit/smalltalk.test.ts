import { it, expect, describe, beforeAll, beforeEach, vi } from 'vitest';
import { step } from '../../src/dialog/machine';
import { newCtx } from '../../src/dialog/states';
import { detectSmalltalk } from '../../src/nlu/smalltalk';
import { stats } from '../../src/services/llm';
import { FIXTURE_SLOTS, useFixtureCatalog } from './fixtures';

const { completeMock, findSlotsMock, nearestSlotsMock, answerKbMock } = vi.hoisted(() => ({
  completeMock: vi.fn(),
  findSlotsMock: vi.fn(),
  nearestSlotsMock: vi.fn(),
  answerKbMock: vi.fn(),
}));

vi.mock('../../src/services/llm', () => ({
  complete: completeMock,
  tryJson: () => null,
  stats: { llmCalls: 0, styleCalls: 0, styleFallbacks: 0 },
}));

vi.mock('../../src/services/slots', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/slots')>();
  return { ...actual, findSlots: findSlotsMock, nearestSlots: nearestSlotsMock };
});

vi.mock('../../src/services/kb', () => ({ answerKb: answerKbMock }));

const NOW = new Date(2026, 9, 20, 12, 0);   // вторник, 20 октября 2026

beforeAll(() => {
  useFixtureCatalog();
  findSlotsMock.mockImplementation(async () => FIXTURE_SLOTS);
  nearestSlotsMock.mockResolvedValue([]);
  answerKbMock.mockResolvedValue({ answerable: true, answer: 'Ответ из базы.', best: null });
});

beforeEach(() => {
  completeMock.mockReset();
  completeMock.mockResolvedValue('Конечно, я рядом.');
  stats.llmCalls = 0;
  stats.styleCalls = 0;
  stats.styleFallbacks = 0;
});

describe('детектор светских реплик', () => {
  it.each([
    ['привет', 'greeting'],
    ['Здравствуйте!', 'greeting'],
    ['спасибо', 'thanks'],
    ['Спасибо, до свидания', 'goodbye'],
    ['как дела?', 'how_are_you'],
    ['как вы?', 'how_are_you'],
    ['ты бот?', 'bot'],
    ['Ты человек?', 'bot'],
    ['я волнуюсь перед стрижкой', 'worry'],
    ['вы супер', 'positive'],
    ['извините', 'apology'],
    ['понятно', 'ack'],
  ])('%s → %s', (text, expected) => {
    expect(detectSmalltalk(text)).toBe(expected);
  });

  it.each([
    'сколько стоит стрижка?',
    'как вы работаете?',
    'хочу записаться',
    'пока не знаю',
    'мне не нравится',
    'к Артёму',
  ])('%s — не светская реплика', (text) => {
    expect(detectSmalltalk(text)).toBeNull();
  });
});

describe('smalltalk сохраняет состояние и не бронирует', () => {
  it('«спасибо» посреди записи: отвечает и повторяет вопрос о дате', async () => {
    const ctx = newCtx('test:smalltalk-date', NOW);
    ctx.state = 'ASK_DATE';
    ctx.lastAsked = 'ASK_DATE';
    ctx.slots.service = 'haircut';

    const res = await step(ctx, { type: 'user_text', text: 'спасибо' }, NOW);

    expect(res.ctx.state).toBe('ASK_DATE');
    expect(res.ctx.outcome).toBeUndefined();
    expect(res.say.join(' ')).toContain('Конечно, я рядом');
    expect(res.say.join(' ')).toContain('На какой день');
    expect(res.actions).toEqual([]);
    expect(res.humanize).toBe(false);
  });

  it('«спасибо» в подтверждении не создаёт запись', async () => {
    const ctx = newCtx('test:smalltalk-confirm', NOW);
    ctx.state = 'CONFIRM';
    ctx.lastAsked = 'CONFIRM';
    ctx.slots = {
      service: 'haircut', date: '2026-10-21', time: '18:00',
      phone: '+79161234567', name: 'иван',
    };

    const res = await step(ctx, { type: 'user_text', text: 'спасибо' }, NOW);

    expect(res.ctx.state).toBe('CONFIRM');
    expect(res.ctx.outcome).toBeUndefined();
    expect(res.actions).toEqual([]);
    expect(res.say.join(' ')).toContain('Конечно, я рядом');
  });

  it('«ты человек?» — не передача оператору, а ответ о боте', async () => {
    completeMock.mockResolvedValue('Да, я бот-администратор.');
    const ctx = newCtx('test:smalltalk-bot', NOW);

    const res = await step(ctx, { type: 'user_text', text: 'Ты человек?' }, NOW);

    expect(res.ctx.outcome).toBeUndefined();
    expect(res.ctx.state).toBe('INTENT');
    expect(res.say.join(' ')).toContain('бот');
  });

  it('«хочу человека» по-прежнему передаёт оператору', async () => {
    const ctx = newCtx('test:smalltalk-human', NOW);
    const res = await step(ctx, { type: 'user_text', text: 'хочу человека' }, NOW);
    expect(res.ctx.outcome).toBe('handoff');
  });

  it('приветствие в начале: отвечает и спрашивает, что нужно', async () => {
    completeMock.mockResolvedValue('Здравствуйте!');
    const ctx = newCtx('test:smalltalk-hello', NOW);

    const res = await step(ctx, { type: 'user_text', text: 'привет' }, NOW);

    expect(res.ctx.state).toBe('INTENT');
    expect(res.say.join(' ')).toContain('Здравствуйте');
    expect(res.say.join(' ')).toContain('Что вам нужно');
  });

  it('«спасибо, завтра» — это дата, а не smalltalk', async () => {
    const ctx = newCtx('test:smalltalk-date-action', NOW);
    ctx.state = 'ASK_DATE';
    ctx.lastAsked = 'ASK_DATE';
    ctx.slots.service = 'haircut';

    const res = await step(ctx, { type: 'user_text', text: 'спасибо, завтра' }, NOW);

    expect(res.ctx.slots.date).toBe('2026-10-21');
    expect(res.ctx.state).toBe('ASK_TIME');
    expect(res.ctx.outcome).toBeUndefined();
  });

  it('«спасибо, к Артёму» — это выбор мастера, а не smalltalk', async () => {
    const ctx = newCtx('test:smalltalk-master-action', NOW);
    ctx.state = 'CONFIRM';
    ctx.lastAsked = 'CONFIRM';
    ctx.slots = {
      service: 'haircut', date: '2026-10-21', time: '18:00',
      phone: '+79161234567', name: 'иван',
    };
    completeMock.mockResolvedValue('null');

    const res = await step(ctx, { type: 'user_text', text: 'спасибо, к Артёму' }, NOW);

    expect(res.ctx.slots.masterId).toBe(1);
    expect(res.ctx.state).toBe('CONFIRM');
  });

  it('модель не прощается посреди записи', async () => {
    completeMock.mockResolvedValue('Всегда пожалуйста, до встречи.');
    const ctx = newCtx('test:smalltalk-farewell', NOW);
    ctx.state = 'ASK_DATE';
    ctx.lastAsked = 'ASK_DATE';
    ctx.slots.service = 'haircut';

    const res = await step(ctx, { type: 'user_text', text: 'спасибо' }, NOW);

    expect(res.ctx.state).toBe('ASK_DATE');
    expect(res.say.join(' ')).toContain('Пожалуйста');
    expect(res.say.join(' ')).not.toContain('до встречи');
    expect(stats.styleFallbacks).toBe(1);
  });

  it('модель недоступна: остаётся шаблон, а диалог продолжается', async () => {
    completeMock.mockRejectedValue(new Error('LLM выключен'));
    const ctx = newCtx('test:smalltalk-fallback', NOW);
    ctx.state = 'ASK_DATE';
    ctx.lastAsked = 'ASK_DATE';
    ctx.slots.service = 'haircut';

    const res = await step(ctx, { type: 'user_text', text: 'спасибо' }, NOW);

    expect(res.say.join(' ')).toContain('Пожалуйста');
    expect(res.say.join(' ')).toContain('На какой день');
    expect(stats.styleFallbacks).toBe(1);
  });
});
