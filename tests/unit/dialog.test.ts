import { it, expect, describe, beforeAll, vi } from 'vitest';
import { step } from '../../src/dialog/machine';
import { newCtx } from '../../src/dialog/states';
import { FIXTURE_SLOTS, useFixtureCatalog } from './fixtures';

// Слоты считает БД, а юнит-тесты не должны зависеть от живой базы:
// подменяем только поиск свободных окон, всё остальное — настоящее.
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

// Реальный вызов LLM в юнит-тестах недопустим: правила справляются сами,
// а модель здесь всегда отвечает ошибкой (экстрактор это молча пропускает).
vi.mock('../../src/services/llm', () => ({
  complete: vi.fn(async () => { throw new Error('LLM выключен в тестах'); }),
  tryJson: () => null,
  stats: { llmCalls: 0 },
}));

// База знаний тоже тестовая: автомату заранее отдаём готовый ответ,
// поиска по эмбеддингам и сети нет. Отказ базы — тесты на отказ ниже.
const { answerKbMock } = vi.hoisted(() => ({ answerKbMock: vi.fn() }));
vi.mock('../../src/services/kb', () => ({ answerKb: answerKbMock }));

const NOW = new Date(2026, 9, 20, 12, 0);   // вторник, 20 октября 2026

beforeAll(() => {
  useFixtureCatalog();
  // Известный ответ по базе для всех FAQ-тестов этого файла.
  answerKbMock.mockResolvedValue({
    answerable: true,
    answer: 'Мужская стрижка стоит 2000 ₽ и занимает около 60 минут.',
    best: null,
  });
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
  findBookingsByTelegramIdMock.mockResolvedValue([]);
});

/** Прогоняет реплики через автомат и собирает всё, что сказал бот. */
async function play(lines: string[]) {
  const ctx = newCtx('test:dialog', NOW);
  const said: string[] = [];
  for (const line of lines) {
    const res = await step(ctx, { type: 'user_text', text: line }, NOW);
    said.push(...res.say);
  }
  return { ctx, said: said.join(' ') };
}

/** То же, но с Telegram-аккаунтом: FIND_BOOKING ищет по from.id. */
async function playAs(telegramId: number, lines: string[]) {
  const ctx = newCtx('tg:' + telegramId, NOW);
  const said: string[] = [];
  for (const line of lines) {
    const res = await step(ctx, { type: 'user_text', text: line }, NOW);
    said.push(...res.say);
  }
  return { ctx, said: said.join(' ') };
}

describe('основной диалог', () => {
  it('проходит запись целиком и подтверждает словами', async () => {
    const { ctx, said } = await play([
      'хочу записаться', 'стрижка', 'завтра', 'в 18:00', '+79161234567', 'Иван', 'да',
    ]);
    expect(said).toContain('Мужская стрижка');
    expect(said).toContain('завтра');
    expect(said).toContain('18:00');
    expect(said).toContain('+79161234567');
    expect(said).toContain('Всё верно?');
    expect(ctx.outcome).toBe('booked');
    expect(ctx.state).toBe('DONE');
  });

  it('названный мастер сохраняется и зачитывается в подтверждении', async () => {
    const { ctx, said } = await play([
      'хочу записаться', 'к Артёму на стрижку завтра', 'в 18:00', '+79161234567', 'Иван',
    ]);
    expect(ctx.slots.masterId).toBe(1);
    expect(said).toContain('мастер Артём');
  });

  it('мастера можно назвать в любой момент', async () => {
    const { ctx } = await play(['хочу записаться', 'стрижка', 'завтра', 'к Руслану', 'в 18:00']);
    expect(ctx.slots.masterId).toBe(2);
  });

  it('«к кому записать?» — отдельный вопрос про мастера', async () => {
    const { ctx, said } = await play(['хочу записаться', 'к кому записать?']);
    expect(said).toContain('К какому мастеру записать');
    expect(ctx.state).toBe('ASK_MASTER');
  });

  it('время-диапазон превращается в конкретное окно', async () => {
    const { ctx, said } = await play(['хочу записаться', 'стрижка', 'завтра', 'после обеда']);
    expect(ctx.state).toBe('OFFER_SLOTS');
    expect(said).toContain('Свободное время');
    expect(ctx.slots.timeRange).toEqual({ from: '13:00', to: '17:00' });

    const picked = await step(ctx, { type: 'user_text', text: '14:00' }, NOW);
    expect(ctx.slots.time).toBe('14:00');
    expect(ctx.slots.timeRange).toBeUndefined();
    expect(ctx.state).toBe('ASK_CONTACT');
    expect(picked.say.join(' ')).toContain('номер телефона');
  });

  it('«нет» в подтверждении — уточняем, что менять', async () => {
    const { ctx, said } = await play([
      'хочу записаться', 'стрижка', 'завтра', 'в 18:00', '+79161234567', 'Иван', 'нет', 'время',
    ]);
    expect(said).toMatch(/Что (изменить|поправить)/);
    expect(ctx.state).toBe('ASK_TIME');
  });

  it('«18» в ответ на вопрос о времени — это час, а не число месяца', async () => {
    const { ctx } = await play(['хочу записаться', 'стрижка', 'завтра', '18']);
    expect(ctx.slots.time).toBe('18:00');
    expect(ctx.slots.date).toBe('2026-10-21');
  });

  it('время вне рабочих часов: сообщаем график, слот не ставим', async () => {
    const { ctx, said } = await play(['хочу записаться', 'стрижка', 'завтра', 'в 23:00']);
    expect(said).toContain('Мы работаем с 10:00 до 21:00');
    expect(ctx.slots.time).toBeUndefined();
  });

  it('«назад» возвращает к предыдущему слоту', async () => {
    const { ctx, said } = await play(['хочу записаться', 'стрижка', 'назад']);
    expect(said).toContain('На какую услугу');
    expect(ctx.slots.service).toBeUndefined();
  });

  it('«повторите» повторяет последнюю реплику бота', async () => {
    const { said } = await play(['хочу записаться', 'повторите']);
    expect(said.match(/На какую услугу/g)?.length).toBe(2);
  });

  it('второе молчание повторяет сам вопрос', async () => {
    const ctx = newCtx('test:dialog', NOW);
    await step(ctx, { type: 'user_text', text: 'хочу записаться' }, NOW);
    await step(ctx, { type: 'silence', ms: 8000 }, NOW);
    const second = await step(ctx, { type: 'silence', ms: 8000 }, NOW);
    expect(second.say.join(' ')).toContain('На какую услугу');
  });

  it('дата в прошлом: уточняем, слот не ставим', async () => {
    const { ctx, said } = await play(['хочу записаться', 'стрижка', 'вчера']);
    expect(said).toContain('уже прошла');
    expect(ctx.slots.date).toBeUndefined();
  });

  it('дата дальше 60 дней: уточняем, слот не ставим', async () => {
    const { ctx, said } = await play(['хочу записаться', 'стрижка', '1 января']);
    expect(said).toContain('не дальше чем на 60 дней');
    expect(ctx.slots.date).toBeUndefined();
  });

  it('две просьбы в одной реплике: после «да» запись продолжается', async () => {
    const { ctx, said } = await play([
      'хочу записаться на стрижку, сколько стоит стрижка?', 'да',
    ]);
    expect(said).toContain('день');
    expect(ctx.state).toBe('ASK_DATE');
    expect(ctx.slots.service).toBe('haircut');
  });
});

describe('имя клиента и выбор мастера', () => {
  const beforePhone = ['хочу записаться', 'стрижка', 'завтра', 'в 18:00'];

  it('неполный телефон не копит цифры, а просит повторить номер целиком', async () => {
    const { ctx, said } = await play([...beforePhone, 'восемь девятьсот шестнадцать']);
    expect(said).toContain('целиком');
    expect(ctx.slots.phone).toBeUndefined();

    await step(ctx, { type: 'user_text', text: '8 916 234 56 78' }, NOW);
    expect(ctx.slots.phone).toBe('+79162345678');
    expect(ctx.state).toBe('ASK_NAME');
  });

  it('после телефона спрашивает имя и сохраняет его', async () => {
    const { ctx, said } = await play([...beforePhone, '+79161234567']);
    expect(ctx.state).toBe('ASK_NAME');
    expect(said).toContain('Как вас зовут');

    await step(ctx, { type: 'user_text', text: 'Иван' }, NOW);
    expect(ctx.slots.name).toBe('Иван');
    expect(ctx.state).toBe('CONFIRM');
  });

  it('имя можно пропустить, запись продолжится', async () => {
    const { ctx } = await play([...beforePhone, '+79161234567', 'пропустить']);
    expect(ctx.slots.name).toBeUndefined();
    expect(ctx.state).toBe('CONFIRM');
  });

  it('неизвестный мастер на подтверждении: список мастеров вместо «не понял»', async () => {
    const { ctx, said } = await play([
      ...beforePhone, '+79161234567', 'Иван', 'хочу мастера Ивана',
    ]);
    expect(ctx.state).toBe('ASK_MASTER');
    expect(said).toContain('Мастера «Ивана» нет');
    expect(said).toContain('Артём');
  });

  it('мастера можно выбрать прямо на подтверждении', async () => {
    const { ctx, said } = await play([
      ...beforePhone, '+79161234567', 'Иван', 'к Артёму',
    ]);
    expect(ctx.state).toBe('CONFIRM');
    expect(ctx.slots.masterId).toBe(1);
    expect(said).toContain('мастер Артём');
  });

  it('после «мастер» показывает список и принимает выбор', async () => {
    const { ctx, said } = await play([
      ...beforePhone, '+79161234567', 'Иван', 'нет', 'мастер',
    ]);
    expect(ctx.state).toBe('ASK_MASTER');
    expect(said).toContain('К какому мастеру записать');

    await step(ctx, { type: 'user_text', text: 'к Диане' }, NOW);
    expect(ctx.state).toBe('CONFIRM');
    expect(ctx.slots.masterId).toBe(3);
  });
});

describe('база знаний (дни 12–13)', () => {
  it('вопрос в начале диалога: ответ из базы и приглашение к действию', async () => {
    const { ctx, said } = await play(['сколько стоит стрижка?']);
    expect(said).toContain('2000 ₽');
    expect(said).toContain('Чем ещё помочь');
    expect(ctx.state).toBe('FAQ');
    expect(ctx.outcome).toBe('faq_answered');
  });

  it('«сколько стоит стрижка, срочно?» — вопрос о цене, а не поиск окон', async () => {
    const { ctx, said } = await play(['сколько стоит стрижка, срочно?']);
    expect(said).toContain('2000 ₽');
    expect(ctx.state).toBe('FAQ');
  });

  it('после ответа «запишите» — начинается обычная запись', async () => {
    const { ctx, said } = await play(['сколько стоит стрижка?', 'запишите меня']);
    expect(ctx.state).toBe('ASK_SERVICE');
    expect(said).toContain('На какую услугу');   // услуга названа раньше — ждём следующего слота
  });

  it('после ответа «нет» — диалог вежливо закрывается', async () => {
    const { ctx, said } = await play(['сколько стоит стрижка?', 'нет']);
    expect(said).toContain('До свидания');
    expect(ctx.state).toBe('DONE');
  });

  it('в FAQ можно задать ещё один вопрос — отвечает база знаний', async () => {
    const { said } = await play(['где вы работаете?', 'а сколько стоит борода?']);
    expect(said).toContain('2000 ₽');
    expect(said).toContain('Чем ещё помочь');
  });

  it('ответа в базе нет — честное «уточню» и остановка записи', async () => {
    answerKbMock.mockResolvedValueOnce({ answerable: false, answer: '', best: null });
    const { ctx, said } = await play(['сколько стоит татуировка?']);
    expect(said).toContain('Уточню у администратора');
    expect(ctx.state).toBe('HANDOFF');
    expect(ctx.outcome).toBe('faq_declined');
  });
});

describe('выбор окна и вопросы посреди записи', () => {
  it('«первый» в списке окон — выбор, а не первое число месяца', async () => {
    const { ctx } = await play(['здравствуйте', 'стрижка', 'завтра', 'после обеда', 'первый']);
    expect(ctx.state).toBe('ASK_CONTACT');
    expect(ctx.slots.date).toBe('2026-10-21');
    expect(ctx.slots.time).toBe('13:00');
  });

  it('дата и диапазон в одной реплике сразу показывают окна, а не спрашивают телефон', async () => {
    const { ctx, said } = await play(['здравствуйте', 'мне бы завтра после обеда', 'стрижка']);
    expect(ctx.slots.date).toBe('2026-10-21');
    expect(ctx.slots.timeRange).toEqual({ from: '13:00', to: '17:00' });
    expect(ctx.state).toBe('OFFER_SLOTS');
    expect(said).toContain('Свободное время');
  });

  it('«когда есть время ближайшее? мне срочно» — предлагает ближайшие окна', async () => {
    nearestSlotsMock.mockResolvedValueOnce([
      {
        date: '2026-10-20',
        slots: [
          { time: '12:30', masterId: 1, masterName: 'Артём' },
          { time: '13:00', masterId: 2, masterName: 'Руслан' },
          { time: '13:30', masterId: 3, masterName: 'Диана' },
        ],
      },
    ]);
    const { ctx, said } = await play([
      'здравствуйте',
      'лобок побрить надо',
      'а когда есть время ближайшее? мне срочно',
    ]);
    expect(ctx.state).toBe('OFFER_SLOTS');
    expect(ctx.nearest).toHaveLength(3);
    expect(said).toContain('Ближайшее свободное время');
    expect(said).not.toContain('Не совсем понял дату');

    await step(ctx, { type: 'user_text', text: '1' }, NOW);
    expect(ctx.slots.date).toBe('2026-10-20');
    expect(ctx.slots.time).toBe('12:30');
    expect(ctx.slots.masterId).toBe(1);
    expect(ctx.state).toBe('ASK_CONTACT');
    expect(ctx.nearest).toBeUndefined();
  });

  it('«когда есть ближайшее?» без услуги — сначала спрашивает услугу', async () => {
    nearestSlotsMock.mockResolvedValueOnce([
      {
        date: '2026-10-20',
        slots: [{ time: '12:30', masterId: 1, masterName: 'Артём' }],
      },
    ]);
    const { ctx, said } = await play(['здравствуйте', 'а когда есть время ближайшее? мне срочно']);
    expect(ctx.state).toBe('ASK_SERVICE');
    expect(ctx.wantsNearest).toBe(true);
    expect(said).toContain('На какую услугу');

    await step(ctx, { type: 'user_text', text: 'стрижка' }, NOW);
    expect(ctx.state).toBe('OFFER_SLOTS');
    expect(ctx.nearest).toHaveLength(1);
    expect(ctx.wantsNearest).toBeUndefined();
  });

  it('если день занят, ближайшие окна учитывают время и мастера', async () => {
    const ctx = newCtx('test:offer-other-days', NOW);
    await step(ctx, { type: 'user_text', text: 'хочу записаться' }, NOW);
    await step(ctx, { type: 'user_text', text: 'стрижка' }, NOW);
    await step(ctx, { type: 'user_text', text: 'завтра' }, NOW);
    ctx.slots.masterId = 1;

    findSlotsMock.mockResolvedValueOnce([]);
    nearestSlotsMock.mockResolvedValueOnce([
      {
        date: '2026-10-21',
        slots: [
          { time: '17:00', masterId: 1, masterName: 'Артём' },
          { time: '17:00', masterId: 1, masterName: 'Артём' },
          { time: '17:30', masterId: 1, masterName: 'Артём' },
        ],
      },
    ]);

    const res = await step(ctx, { type: 'user_text', text: 'после обеда' }, NOW);
    expect(nearestSlotsMock).toHaveBeenCalledWith('haircut', '2026-10-21', NOW, 7, 3, {
      masterId: 1,
      range: { from: '13:00', to: '17:00' },
      uniqueTimes: true,
    });
    expect(res.say.join(' ')).toContain('17:00, 17:30');
    expect(res.say.join(' ')).not.toContain('17:00, 17:00');
  });

  it('«любое» в списке окон выбирает ближайшее время, а не повторяет список', async () => {
    const { ctx } = await play(['хочу записаться', 'стрижка', 'завтра', 'после обеда']);
    expect(ctx.state).toBe('OFFER_SLOTS');

    const res = await step(ctx, { type: 'user_text', text: 'любое' }, NOW);
    expect(res.ctx.slots.time).toBe('13:00');
    expect(res.ctx.state).toBe('ASK_CONTACT');
    expect(res.say.join(' ')).not.toContain('Свободное время');
  });

  it('«любое время» в списке окон — тоже выбор ближайшего', async () => {
    const { ctx } = await play(['хочу записаться', 'стрижка', 'завтра', 'после обеда']);
    expect(ctx.state).toBe('OFFER_SLOTS');

    const res = await step(ctx, { type: 'user_text', text: 'любое время' }, NOW);
    expect(res.ctx.slots.time).toBe('13:00');
    expect(res.ctx.state).toBe('ASK_CONTACT');
    expect(res.say.join(' ')).not.toContain('Свободное время');
  });

  it('«13 диана» в списке окон — это время и мастер, а не 13-е число', async () => {
    const { ctx } = await play(['хочу записаться', 'стрижка', 'давай на после завтра после обеда']);
    expect(ctx.state).toBe('OFFER_SLOTS');
    expect(ctx.slots.date).toBe('2026-10-22');

    await step(ctx, { type: 'user_text', text: '13 диана' }, NOW);
    expect(ctx.slots.date).toBe('2026-10-22');
    expect(ctx.slots.time).toBe('13:00');
    expect(ctx.slots.masterId).toBe(3);
    expect(ctx.state).toBe('ASK_CONTACT');
  });

  it('«13 диана» в ответ на вопрос о времени — тоже время и мастер', async () => {
    const { ctx } = await play(['хочу записаться', 'стрижка', 'завтра', '13 диана']);
    expect(ctx.slots.date).toBe('2026-10-21');
    expect(ctx.slots.time).toBe('13:00');
    expect(ctx.slots.masterId).toBe(3);
    expect(ctx.state).toBe('ASK_CONTACT');
  });

  it('«Можно ли прийти без записи?» — вопрос, а не запись', async () => {
    const { ctx, said } = await play(['Можно ли прийти без записи?']);
    expect(ctx.state).toBe('FAQ');
    expect(ctx.outcome).toBe('faq_answered');
    expect(said).toContain('2000 ₽');
  });

  it('«За сколько часов можно отменить?» — вопрос о правилах, а не отмена', async () => {
    const { ctx } = await play(['За сколько часов можно отменить запись?']);
    expect(ctx.state).toBe('FAQ');
    expect(ctx.outcome).toBe('faq_answered');
    expect(ctx.pending).toBeUndefined();
  });

  it('цена в одной реплике с записью: сначала ответ, потом продолжение', async () => {
    const { ctx, said } = await play(['хочу записаться на стрижку и узнать цену']);
    expect(ctx.state).toBe('RESUME');
    expect(said).toContain('2000 ₽');
    expect(said).toContain('Продолжим запись');
  });

  it('«во сколько можно записаться» — это время записи, а не часы работы', async () => {
    const { ctx } = await play(['хочу подстричся во скок можно завтра']);
    expect(ctx.state).toBe('ASK_TIME');
    expect(ctx.slots.date).toBe('2026-10-21');
  });
});

describe('записи по Telegram-аккаунту', () => {
  const booking = {
    id: 42, masterId: 1, masterName: 'Артём',
    serviceCode: 'haircut', serviceTitle: 'Мужская стрижка',
    date: '2026-10-21', time: '12:00',
  };

  it('перенос ищет запись по from.id, а не по телефону', async () => {
    findBookingsByTelegramIdMock.mockResolvedValueOnce([booking]);
    const { ctx, said } = await playAs(1001, ['хочу перенести запись']);
    expect(findBookingsByTelegramIdMock).toHaveBeenCalledWith(1001, NOW);
    expect(said).not.toContain('номер телефона');
    expect(ctx.state).toBe('ASK_DATE');
    expect(ctx.bookingId).toBe(42);
    expect(ctx.slots.service).toBe('haircut');
    expect(ctx.slots.masterId).toBe(1);
  });

  it('старые записи без привязки не показываются — только администратор', async () => {
    findBookingsByTelegramIdMock.mockResolvedValueOnce([]);
    const { ctx, said } = await playAs(1002, ['хочу отменить запись']);
    expect(ctx.state).toBe('HANDOFF');
    expect(ctx.outcome).toBe('handoff');
    expect(said).toContain('Не нашёл предстоящих записей');
    expect(said).toContain('телефон');
    expect(said).not.toContain('Мужская стрижка');
  });
});

describe('сброс диалога', () => {
  it('/reset выбрасывает начатую запись и начинает заново', async () => {
    const { ctx } = await play(['хочу записаться', 'стрижка', 'завтра']);
    expect(ctx.slots.service).toBe('haircut');

    const res = await step(ctx, { type: 'reset' }, NOW);
    expect(res.ctx).not.toBe(ctx);                 // старый контекст не переиспользуем
    expect(res.ctx.state).toBe('INTENT');
    expect(res.ctx.slots).toEqual({});
    expect(res.ctx.history.filter((h) => h.role === 'user')).toHaveLength(0);
    expect(res.say.join(' ')).toContain('начнём заново');
    expect(res.say.join(' ')).toContain('Что вам нужно');
    expect(res.humanize).toBe(false);

    // Следующая реплика продолжает уже новый диалог, без повторного приветствия.
    const next = await step(res.ctx, { type: 'user_text', text: 'стрижка' }, NOW);
    expect(next.ctx.state).toBe('ASK_DATE');
    expect(next.say.join(' ')).not.toContain('начнём заново');
  });
});
