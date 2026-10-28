import { it, expect, describe, beforeAll, beforeEach, vi } from 'vitest';
import { humanize, replaceLastBotTurns } from '../../src/dialog/humanize';
import { newCtx } from '../../src/dialog/states';
import { stats } from '../../src/services/llm';
import { useFixtureCatalog } from './fixtures';

const { completeMock } = vi.hoisted(() => ({ completeMock: vi.fn() }));

vi.mock('../../src/services/llm', () => ({
  complete: completeMock,
  tryJson: () => null,
  stats: { llmCalls: 0, styleCalls: 0, styleFallbacks: 0 },
}));

const NOW = new Date(2026, 9, 20, 12, 0);

beforeAll(() => useFixtureCatalog());

beforeEach(() => {
  completeMock.mockReset();
  completeMock.mockResolvedValue('Отлично, давайте подберём.');
  stats.llmCalls = 0;
  stats.styleCalls = 0;
  stats.styleFallbacks = 0;
  delete process.env.LLM_HUMANIZE;
  delete process.env.LLM_STYLE_TEMPERATURE;
});

const baseCtx = () => {
  const ctx = newCtx('test:humanize', NOW);
  ctx.state = 'INTENT';
  ctx.lastAsked = 'INTENT';
  return ctx;
};

describe('живая вводная фраза', () => {
  it('добавляет короткую фразу и сохраняет готовый ответ целиком', async () => {
    const core = 'На какую услугу вас записать?';
    const out = await humanize({ ctx: baseCtx(), userText: 'хочу стрижку', say: [core] });

    expect(out).toEqual(['Отлично, давайте подберём. ' + core]);
    expect(out[0]).toContain(core);
    expect(stats.styleCalls).toBe(1);
    expect(completeMock).toHaveBeenCalledWith(expect.objectContaining({
      jsonMode: false,
      temperature: 0.7,
    }));
  });

  it('добавляет точку, если модель вернула фразу без знака конца', async () => {
    completeMock.mockResolvedValue('Хорошо');
    const out = await humanize({ ctx: baseCtx(), userText: 'хочу стрижку', say: ['На какую услугу?'] });
    expect(out[0]).toBe('Хорошо. На какую услугу?');
  });

  it.each([
    ['Скидка 50% на всё.'],
    ['Хорошо, а какой мастер?'],
    ['Записываю на стрижку.'],
    ['Артём будет ждать.'],
    ['Свободное окно уже есть.'],
    ['Цена ниже.'],
    ['🙂'],
  ])('отбрасывает опасную фразу: %s', async (prefix) => {
    completeMock.mockResolvedValue(prefix);
    const core = 'На какую услугу вас записать?';
    const out = await humanize({ ctx: baseCtx(), userText: 'хочу стрижку', say: [core] });
    expect(out).toEqual([core]);
    expect(stats.styleFallbacks).toBe(1);
  });

  it('не дублирует ответ, если модель повторила его целиком', async () => {
    const core = 'Назовите, пожалуйста, номер телефона для записи.';
    completeMock.mockResolvedValue('Спасибо! ' + core);
    const out = await humanize({ ctx: baseCtx(), userText: 'в 18:00', say: [core] });
    expect(out).toEqual(['Спасибо! ' + core]);
  });

  it('спасает вводную фразу перед повторённым вопросом', async () => {
    const core = 'На какой день вас записать?';
    completeMock.mockResolvedValue('Понял вас, будем рады помочь. ' + core);
    const out = await humanize({ ctx: baseCtx(), userText: 'стрижка', say: [core] });
    expect(out).toEqual(['Понял вас, будем рады помочь. ' + core]);
  });

  it('если модель вернула только готовый ответ — не стилизует', async () => {
    const core = 'На какой день вас записать?';
    completeMock.mockResolvedValue(core);
    const out = await humanize({ ctx: baseCtx(), userText: 'стрижка', say: [core] });
    expect(out).toEqual([core]);
  });

  it('не трогает приветствие и серьёзные ответы', async () => {
    const hello = 'Здравствуйте! Я бот-администратор.';
    const out = await humanize({ ctx: baseCtx(), userText: 'привет', say: [hello] });
    expect(out).toEqual([hello]);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('не трогает handoff', async () => {
    const ctx = baseCtx();
    ctx.state = 'HANDOFF';
    ctx.outcome = 'handoff';
    const text = 'Передаю вас администратору.';
    const out = await humanize({ ctx, userText: 'жалоба', say: [text] });
    expect(out).toEqual([text]);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('уважает enabled=false и LLM_HUMANIZE=0', async () => {
    const core = 'На какую услугу?';
    const off = await humanize({ ctx: baseCtx(), userText: 'хочу стрижку', say: [core], enabled: false });
    expect(off).toEqual([core]);

    process.env.LLM_HUMANIZE = '0';
    const disabled = await humanize({ ctx: baseCtx(), userText: 'хочу стрижку', say: [core] });
    expect(disabled).toEqual([core]);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('модель упала — остаётся исходный ответ', async () => {
    completeMock.mockRejectedValue(new Error('LLM выключен'));
    const core = 'На какую услугу?';
    const out = await humanize({ ctx: baseCtx(), userText: 'хочу стрижку', say: [core] });
    expect(out).toEqual([core]);
    expect(stats.styleFallbacks).toBe(1);
  });
});

describe('история после стилизации', () => {
  it('заменяет последние реплики бота, не трогая реплику клиента', () => {
    const ctx = baseCtx();
    const raw = ['На какую услугу?', 'Например: стрижка.'];
    ctx.history.push({ role: 'user', text: 'хочу стрижку', at: NOW.getTime() });
    for (const text of raw) ctx.history.push({ role: 'bot', text, at: NOW.getTime() });

    replaceLastBotTurns(ctx, raw, ['Отлично. На какую услугу?', 'Например: стрижка.']);

    expect(ctx.history.map((h) => h.text)).toEqual([
      'хочу стрижку',
      'Отлично. На какую услугу?',
      'Например: стрижка.',
    ]);
  });
});
