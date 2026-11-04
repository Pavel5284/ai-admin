import { it, expect, describe, beforeAll, beforeEach, vi } from 'vitest';
import { step } from '../../src/dialog/machine';
import { newCtx } from '../../src/dialog/states';
import { FIXTURE_SLOTS, useFixtureCatalog } from './fixtures';

// Матрица диалогов: проверяем не отдельные функции, а поведение автомата
// на всех вариантах ответов клиента. Слоты и база знаний подменяются:
// тест не зависит от живой PostgreSQL и сети.
const { findSlotsMock, nearestSlotsMock, findBookingsByTelegramIdMock } = vi.hoisted(() => ({
  findSlotsMock: vi.fn(),
  nearestSlotsMock: vi.fn(),
  findBookingsByTelegramIdMock: vi.fn(),
}));

vi.mock('../../src/services/slots', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/slots')>();
  return {
    ...actual,
    findSlots: findSlotsMock,
    nearestSlots: nearestSlotsMock,
    findBookingsByTelegramId: findBookingsByTelegramIdMock,
  };
});

vi.mock('../../src/services/llm', () => ({
  complete: vi.fn(async () => { throw new Error('LLM выключен в тестах'); }),
  tryJson: () => null,
  stats: { llmCalls: 0, styleCalls: 0, styleFallbacks: 0 },
}));

const { answerKbMock } = vi.hoisted(() => ({ answerKbMock: vi.fn() }));
vi.mock('../../src/services/kb', () => ({ answerKb: answerKbMock }));

const NOW = new Date(2026, 9, 20, 12, 0);   // вторник, 20 октября 2026

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
});

beforeEach(() => {
  nearestSlotsMock.mockReset();
  nearestSlotsMock.mockResolvedValue([]);
  findBookingsByTelegramIdMock.mockReset();
  findBookingsByTelegramIdMock.mockResolvedValue([]);
  answerKbMock.mockReset();
  answerKbMock.mockResolvedValue({
    answerable: true,
    answer: 'Мужская стрижка стоит 2000 ₽ и занимает около 60 минут.',
    best: null,
  });
});

async function play(lines: string[], ctx = newCtx('test:matrix', NOW)) {
  const said: string[] = [];
  for (const line of lines) {
    const res = await step(ctx, { type: 'user_text', text: line }, NOW);
    said.push(...res.say);
  }
  return { ctx, said: said.join(' ') };
}

async function playAs(telegramId: number, lines: string[]) {
  return play(lines, newCtx('tg:' + telegramId, NOW));
}

const toConfirm = (service = 'стрижка', time = 'в 18:00') => [
  'хочу записаться', service, 'завтра', time, '+79161234567', 'Иван',
];

const booking = (over: Record<string, unknown> = {}) => ({
  id: 42,
  masterId: 1,
  masterName: 'Артём',
  serviceCode: 'haircut',
  serviceTitle: 'Мужская стрижка',
  date: '2026-10-21',
  time: '12:00',
  clientPhone: '+79160000042',
  ...over,
});

describe('матрица услуг', () => {
  it.each([
    ['стрижка', 'haircut'],
    ['борода', 'beard'],
    ['комплекс', 'combo'],
    ['детская стрижка', 'kids'],
    ['бритьё', 'shave'],
    ['укладка', 'styling'],
  ])('услуга «%s» → %s', async (phrase, code) => {
    const { ctx, said } = await play([...toConfirm(phrase), 'да']);
    expect(ctx.slots.service).toBe(code);
    expect(ctx.state).toBe('DONE');
    expect(ctx.outcome).toBe('booked');
    expect(said).toContain('Готово, вы записаны');
  });
});

describe('матрица мастеров', () => {
  it.each([
    ['к Артёму', 1, 'в 18:00'],
    ['к Руслану', 2, 'в 18:30'],
    ['к Диане', 3, 'в 19:00'],
  ])('мастер «%s» → id %i', async (phrase, id, time) => {
    const { ctx } = await play([
      'хочу записаться', 'стрижка', 'завтра', phrase, time, '+79161234567', 'Иван', 'да',
    ]);
    expect(ctx.slots.masterId).toBe(id);
    expect(ctx.state).toBe('DONE');
  });

  it('«к любому» не закрепляет мастера', async () => {
    const { ctx } = await play([
      'хочу записаться', 'стрижка', 'к какому мастеру?', 'к любому',
      'завтра', 'в 18:00', '+79161234567', 'Иван', 'да',
    ]);
    expect(ctx.slots.masterId).toBeUndefined();
    expect(ctx.state).toBe('DONE');
  });
});

describe('матрица дат и времени', () => {
  it.each([
    ['завтра', '2026-10-21'],
    ['послезавтра', '2026-10-22'],
    ['в субботу', '2026-10-24'],
    ['в следующий вторник', '2026-10-27'],
  ])('дата «%s» → %s', async (phrase, date) => {
    const { ctx } = await play(['хочу записаться', 'стрижка', phrase, 'в 18:00']);
    expect(ctx.slots.date).toBe(date);
  });

  it.each([
    ['в 10:00', '10:00'],
    ['в 18:30', '18:30'],
    ['в шесть вечера', '18:00'],
    ['18', '18:00'],
  ])('время «%s» → %s', async (phrase, time) => {
    const { ctx } = await play(['хочу записаться', 'стрижка', 'завтра', phrase]);
    expect(ctx.slots.time).toBe(time);
    expect(ctx.state).toBe('ASK_CONTACT');
  });

  it('«после обеда» — диапазон, а не конкретное время', async () => {
    const { ctx, said } = await play(['хочу записаться', 'стрижка', 'завтра', 'после обеда']);
    expect(ctx.slots.timeRange).toEqual({ from: '13:00', to: '17:00' });
    expect(ctx.state).toBe('OFFER_SLOTS');
    expect(said).toContain('Свободное время');
  });
});

describe('матрица телефонов', () => {
  it.each([
    ['+79161234567', '+79161234567'],
    ['8 916 234 56 78', '+79162345678'],
    ['89161234567', '+79161234567'],
    ['916 234 56 78', '+79162345678'],
    ['9162345678', '+79162345678'],
  ])('телефон «%s» → %s', async (phrase, phone) => {
    const { ctx } = await play(['хочу записаться', 'стрижка', 'завтра', 'в 18:00', phrase]);
    expect(ctx.slots.phone).toBe(phone);
    expect(ctx.state).toBe('ASK_NAME');
  });

  it('10 цифр с семёркой — подсказка про недостающую цифру', async () => {
    const { ctx, said } = await play(['хочу записаться', 'стрижка', 'завтра', 'в 18:00', '7898797898']);
    expect(ctx.state).toBe('ASK_CONTACT');
    expect(said).toContain('не хватает одной цифры');
  });
});

describe('матрица имени и подтверждения', () => {
  it.each([
    ['Иван', 'Иван'],
    ['меня зовут Иван', 'Иван'],
    ['зовут Пётр', 'Пётр'],
  ])('имя «%s» → %s', async (phrase, name) => {
    const { ctx } = await play([
      'хочу записаться', 'стрижка', 'завтра', 'в 18:00', '+79161234567', phrase,
    ]);
    expect(ctx.slots.name).toBe(name);
    expect(ctx.state).toBe('CONFIRM');
  });

  it.each(['пропустить', 'не надо', 'нет'])('имя можно пропустить: «%s»', async (phrase) => {
    const { ctx } = await play([
      'хочу записаться', 'стрижка', 'завтра', 'в 18:00', '+79161234567', phrase,
    ]);
    expect(ctx.nameSkipped).toBe(true);
    expect(ctx.slots.name).toBeUndefined();
    expect(ctx.state).toBe('CONFIRM');
  });

  it.each(['да', 'верно', 'подтверждаю', 'ок', 'да, всё верно'])(
    'подтверждение «%s» создаёт запись',
    async (phrase) => {
      const { ctx, said } = await play([...toConfirm(), phrase]);
      expect(ctx.state).toBe('DONE');
      expect(ctx.outcome).toBe('booked');
      expect(said).toContain('Готово, вы записаны');
    },
  );

  it('«нет» на подтверждении спрашивает, что изменить', async () => {
    const { ctx, said } = await play([...toConfirm(), 'нет']);
    expect(ctx.state).toBe('CONFIRM');
    expect(ctx.pending).toBe('change');
    expect(said).toMatch(/Что (изменить|поправить)/);
  });
});

describe('выбор из списка окон', () => {
  const toSlots = () => play(['хочу записаться', 'стрижка', 'завтра', 'после обеда']);

  it.each([
    ['1', '13:00'],
    ['2', '13:30'],
    ['3', '14:00'],
    ['первый', '13:00'],
    ['второй', '13:30'],
    ['третий', '14:00'],
    ['первую', '13:00'],
    ['вторую', '13:30'],
    ['третью', '14:00'],
    ['первое', '13:00'],
    ['второе', '13:30'],
    ['третье', '14:00'],
  ])('вариант «%s» → %s', async (phrase, time) => {
    const { ctx } = await toSlots();
    await step(ctx, { type: 'user_text', text: phrase }, NOW);
    expect(ctx.slots.time).toBe(time);
    expect(ctx.state).toBe('ASK_CONTACT');
  });

  it.each(['любое', 'любой', 'без разницы', 'неважно', 'как удобнее', 'первый вариант'])(
    '«%s» выбирает ближайшее окно',
    async (phrase) => {
      const { ctx } = await toSlots();
      await step(ctx, { type: 'user_text', text: phrase }, NOW);
      expect(ctx.slots.time).toBe('13:00');
      expect(ctx.state).toBe('ASK_CONTACT');
    },
  );

  it('«любой» на вопросе о дате показывает ближайшие окна', async () => {
    nearestSlotsMock.mockResolvedValueOnce([
      { date: '2026-10-21', slots: [{ time: '12:30', masterId: 1, masterName: 'Артём' }] },
    ]);
    const { ctx, said } = await play(['хочу записаться', 'стрижка']);
    const res = await step(ctx, { type: 'user_text', text: 'любой' }, NOW);
    expect(ctx.state).toBe('OFFER_SLOTS');
    expect(res.say.join(' ')).toContain('Ближайшее свободное время');
    expect(said).not.toContain('Ближайшее свободное время');
  });

  it('«любое» на вопросе о времени показывает ближайшие окна', async () => {
    nearestSlotsMock.mockResolvedValueOnce([
      { date: '2026-10-21', slots: [{ time: '12:30', masterId: 1, masterName: 'Артём' }] },
    ]);
    const { ctx } = await play(['хочу записаться', 'стрижка', 'завтра']);
    const res = await step(ctx, { type: 'user_text', text: 'любое' }, NOW);
    expect(ctx.state).toBe('OFFER_SLOTS');
    expect(res.say.join(' ')).toContain('Ближайшее свободное время');
  });
});

describe('несколько записей', () => {
  const twoBookings = [
    booking({ id: 1, time: '12:00', serviceTitle: 'Мужская стрижка' }),
    booking({ id: 2, time: '15:00', serviceTitle: 'Оформление бороды', serviceCode: 'beard' }),
  ];

  it.each([
    ['первую', 1],
    ['вторую', 2],
    ['1', 1],
    ['2', 2],
  ])('«%s» выбирает запись id %i', async (phrase, id) => {
    findBookingsByTelegramIdMock.mockResolvedValueOnce(twoBookings);
    const { ctx } = await playAs(2001, ['хочу отменить запись']);
    expect(ctx.state).toBe('FIND_BOOKING');
    expect(ctx.bookings).toHaveLength(2);

    const res = await step(ctx, { type: 'user_text', text: phrase }, NOW);
    expect(ctx.bookingId).toBe(id);
    expect(res.say.join(' ')).toContain('Отменяем запись');
  });
});

describe('отмена и перенос: опасные развилки', () => {
  it('«за сколько часов можно отменить?» — вопрос, а не отмена', async () => {
    const { ctx, said } = await play(['за сколько часов можно отменить?']);
    expect(ctx.state).toBe('FAQ');
    expect(ctx.outcome).toBe('faq_answered');
    expect(ctx.pending).toBeUndefined();
    expect(said).toContain('2000 ₽');
  });

  it('вопрос про отмену посреди записи не сбрасывает запись', async () => {
    const { ctx, said } = await play([
      'хочу записаться', 'стрижка', 'завтра', 'за сколько часов можно отменить?',
    ]);
    expect(ctx.state).toBe('RESUME');
    expect(ctx.resume).toBe('ASK_TIME');
    expect(ctx.pending).toBeUndefined();
    expect(said).toContain('Продолжим запись');
  });

  it.each(['хочу отменить', 'хочу отменить запись', 'отмените запись', 'отмена'])(
    '«%s» в начале — сценарий отмены, а не глобальное подтверждение',
    async (phrase) => {
      const { ctx, said } = await play([phrase]);
      expect(ctx.state).toBe('FIND_BOOKING');
      expect(ctx.pending).toBe('cancel');
      expect(said).toContain('номер телефона');
    },
  );

  it.each(['хочу перенести', 'перенесите запись', 'другое время', 'передвинуть'])(
    '«%s» в начале — сценарий переноса',
    async (phrase) => {
      const { ctx } = await play([phrase]);
      expect(ctx.state).toBe('FIND_BOOKING');
      expect(ctx.pending).toBe('reschedule');
    },
  );

  it('«стоп» посреди записи: «нет» возвращает к тому же вопросу', async () => {
    const { ctx, said } = await play(['хочу записаться', 'стрижка', 'завтра', 'стоп', 'нет']);
    expect(said).toContain('Отменить запись?');
    expect(ctx.state).toBe('ASK_TIME');
    expect(ctx.pending).toBeUndefined();
  });

  it('«стоп» посреди переноса: «да» прекращает перенос, запись не отменяется', async () => {
    findBookingsByTelegramIdMock.mockResolvedValueOnce([booking()]);
    const { ctx } = await playAs(2002, ['хочу перенести запись', 'стоп']);
    expect(ctx.state).toBe('CONFIRM');
    expect(ctx.pending).toBe('cancel_reschedule');

    const res = await step(ctx, { type: 'user_text', text: 'да' }, NOW);
    expect(res.ctx.state).toBe('DONE');
    expect(res.actions).toEqual([]);
    expect(res.say.join(' ')).toContain('оставил запись без изменений');
    expect(res.ctx.outcome).toBeUndefined();
  });

  it('«стоп» посреди переноса: «нет» возвращает к выбору даты', async () => {
    findBookingsByTelegramIdMock.mockResolvedValueOnce([booking()]);
    const { ctx } = await playAs(2003, ['хочу перенести запись', 'стоп', 'нет']);
    expect(ctx.state).toBe('ASK_DATE');
    expect(ctx.pending).toBe('reschedule');
    expect(ctx.bookingId).toBe(42);
  });

  it('«отмените запись» посреди переноса отменяет саму запись', async () => {
    findBookingsByTelegramIdMock.mockResolvedValueOnce([booking()]);
    const { ctx } = await playAs(2004, ['хочу перенести запись', 'отмените запись']);
    expect(ctx.state).toBe('CONFIRM');
    expect(ctx.pending).toBe('cancel');
    expect(ctx.bookingId).toBe(42);
  });
});

describe('перенос: сообщение и поправки', () => {
  it('после «да» называет новую дату и время', async () => {
    findBookingsByTelegramIdMock.mockResolvedValueOnce([booking()]);
    const { ctx } = await playAs(2005, ['хочу перенести запись', 'на субботу', 'в 12:00']);
    expect(ctx.state).toBe('CONFIRM');
    const res = await step(ctx, { type: 'user_text', text: 'да' }, NOW);
    const text = res.say.join(' ');
    expect(text).toContain('перенёс запись');
    expect(text).toContain('в субботу');
    expect(text).toContain('12:00');
  });

  it('«нет, лучше в 18:00» на подтверждении переноса правит время', async () => {
    findBookingsByTelegramIdMock.mockResolvedValueOnce([booking()]);
    const { ctx } = await playAs(2006, ['хочу перенести запись', 'на субботу', 'в 12:00']);
    const res = await step(ctx, { type: 'user_text', text: 'нет, лучше в 18:00' }, NOW);
    expect(ctx.slots.time).toBe('18:00');
    expect(ctx.state).toBe('CONFIRM');
    expect(res.say.join(' ')).toContain('18:00');
  });
});

describe('прямые поправки на подтверждении', () => {
  it('время без слова «время»', async () => {
    const { ctx } = await play(toConfirm());
    const res = await step(ctx, { type: 'user_text', text: 'в 19:00' }, NOW);
    expect(ctx.slots.time).toBe('19:00');
    expect(ctx.state).toBe('CONFIRM');
    expect(res.say.join(' ')).toContain('19:00');
  });

  it('дата без слова «дата»', async () => {
    const { ctx } = await play(toConfirm());
    await step(ctx, { type: 'user_text', text: 'послезавтра' }, NOW);
    expect(ctx.slots.date).toBe('2026-10-22');
    expect(ctx.state).toBe('CONFIRM');
  });

  it('услуга без слова «услуга»', async () => {
    const { ctx } = await play(toConfirm());
    await step(ctx, { type: 'user_text', text: 'борода' }, NOW);
    expect(ctx.slots.service).toBe('beard');
    expect(ctx.state).toBe('CONFIRM');
  });

  it('телефон без слова «телефон»', async () => {
    const { ctx } = await play(toConfirm());
    await step(ctx, { type: 'user_text', text: '+79161112233' }, NOW);
    expect(ctx.slots.phone).toBe('+79161112233');
    expect(ctx.state).toBe('CONFIRM');
  });

  it('имя без слова «имя»', async () => {
    const { ctx } = await play(toConfirm());
    await step(ctx, { type: 'user_text', text: 'меня зовут Пётр' }, NOW);
    expect(ctx.slots.name).toBe('Пётр');
    expect(ctx.state).toBe('CONFIRM');
  });
});

describe('светская реплика и повтор', () => {
  it('«повторите» первым сообщением не оставляет пустой ответ', async () => {
    const { ctx, said } = await play(['повторите']);
    expect(ctx.state).toBe('INTENT');
    expect(said).toContain('Здравствуйте');
    expect(said).toContain('Что вам нужно');
  });

  it('«спасибо» в списке ближайших окон повторяет именно список', async () => {
    nearestSlotsMock.mockResolvedValueOnce([
      { date: '2026-10-21', slots: [{ time: '12:30', masterId: 1, masterName: 'Артём' }] },
    ]);
    const { ctx } = await play(['хочу записаться', 'стрижка', 'а когда есть ближайшее?']);
    expect(ctx.state).toBe('OFFER_SLOTS');

    const res = await step(ctx, { type: 'user_text', text: 'спасибо' }, NOW);
    expect(res.say.join(' ')).toContain('Ближайшее свободное время');
    expect(res.say.join(' ')).toContain('12:30');
  });
});

describe('перебор списка окон', () => {
  it('непонятный ответ не повторяет список вечно: переспрос, другие дни', async () => {
    const { ctx } = await play(['хочу записаться', 'стрижка', 'завтра', 'после обеда']);
    expect(ctx.state).toBe('OFFER_SLOTS');

    const first = await step(ctx, { type: 'user_text', text: 'абракадабра' }, NOW);
    expect(ctx.state).toBe('OFFER_SLOTS');
    expect(first.say.join(' ')).toContain('номер варианта');

    const second = await step(ctx, { type: 'user_text', text: 'ерунда' }, NOW);
    expect(second.ctx.state).toBe('ASK_DATE');
    expect(second.say.join(' ')).toMatch(/Ближайшие окна|свободных окон нет/);
  });
});
