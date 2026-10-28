import { it, expect, describe, beforeAll, beforeEach, afterAll, vi, afterEach } from 'vitest';
import { answerKb, searchKb, numbersOk, distMax, expandQuery } from '../../src/services/kb';

/**
 * Юнит-тесты защиты от выдумок (D-012): БД и модель подменены, сети нет.
 * Проверяются сами правила: порог, схема JSON, источник фрагментов,
 * числа из ответа и отказ при любой ошибке — бот не падает на вопросе.
 */

const { queryMock, completeMock } = vi.hoisted(() => ({ queryMock: vi.fn(), completeMock: vi.fn() }));

vi.mock('../../src/services/db', () => ({ pool: { query: queryMock } }));

vi.mock('../../src/services/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/llm')>();
  return { ...actual, complete: completeMock };
});

// Фиксированный вектор эмбеддинга вместо сети: fetch возвращает столько «магии», сколько нужно.
const VECTOR = Array.from({ length: 1024 }, (_, i) => (i % 7) * 0.01);

vi.stubGlobal('fetch', vi.fn(async () =>
  new Response(JSON.stringify({ data: [{ embedding: VECTOR }] }), { status: 200 }),
));

const CHUNKS = [
  { id: 3, title: 'Мужская стрижка', text: 'Мужская стрижка стоит 2000 ₽ и занимает около 60 минут.', dist: 0.12 },
  { id: 7, title: 'Часы работы', text: 'Барбершоп открыт ежедневно с 10:00 до 21:00.', dist: 0.45 },
];

beforeAll(() => {
  vi.stubEnv('KB_DIST_MAX', '0.6');      // порог известен: 0.12 проходит, 0.9 нет
});

afterEach(() => {
  queryMock.mockReset();
  completeMock.mockReset();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

/** Подставляет фрагменты в поиск; запрос пулла возвращает их как есть. */
function givenChunks(rows: typeof CHUNKS | null, fail = false): void {
  queryMock.mockImplementation(async (_sql: string, _params: unknown[]) => {
    if (fail) throw new Error('БД недоступна');
    return { rows: rows ?? [] };
  });
}

/** Модель отвечает ровно этим JSON. */
function modelAnswers(answerable: boolean, answer: string, sourceIds: number[]): void {
  completeMock.mockResolvedValue(JSON.stringify({ answerable, answer, source_ids: sourceIds }));
}

describe('searchKb', () => {
  it('возвращает фрагменты с расстоянием от БД', async () => {
    givenChunks(CHUNKS);
    const chunks = await searchKb('сколько стоит стрижка');
    expect(chunks).toEqual(CHUNKS);
  });

  it('ошибка БД не прилетает наверх — вызывающая сторона получит отказ', async () => {
    givenChunks(null, true);
    const result = await answerKb('сколько стоит стрижка?');
    expect(result.answerable).toBe(false);
    expect(result.best).toBeNull();
  });
});

describe('answerKb: ответ есть', () => {
  beforeEach(() => {
    givenChunks(CHUNKS);
  });

  it('модель ответила по фрагментам — ответ проходит', async () => {
    modelAnswers(true, 'Мужская стрижка стоит 2000 ₽ и длится около 60 минут.', [3]);
    const result = await answerKb('сколько стоит мужская стрижка?');
    expect(result.answerable).toBe(true);
    expect(result.answer).toContain('2000 ₽');
    expect(result.best?.id).toBe(3);
  });

  it('пробел внутри числа не считается выдумкой: «2 000» равно «2000»', async () => {
    modelAnswers(true, 'Стрижка стоит 2 000 ₽.', [3]);
    const result = await answerKb('сколько стоит мужская стрижка?');
    expect(result.answerable).toBe(true);
  });

  it('ответ без чисел можно не проверять на источник чисел', async () => {
    modelAnswers(true, 'Вход со двора, вывеска «Борода».', [7]);   // id 7 — реальный фрагмент
    const result = await answerKb('где вы находитесь?');
    expect(result.answerable).toBe(true);
  });

});

describe('answerKb: отказы', () => {
  beforeEach(() => {
    givenChunks(CHUNKS);
  });

  it('лучший фрагмент дальше порога — модель даже не вызывается', async () => {
    givenChunks([{ ...CHUNKS[0], dist: 0.9 }]);
    const result = await answerKb('какие-то странные вещи спрашиваю');
    expect(result.answerable).toBe(false);
    expect(result.best?.dist).toBe(0.9);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('число в ответе есть во фрагментах — иначе ответ отбрасывается целиком', async () => {
    modelAnswers(true, 'Мужская стрижка стоит 2500 ₽ и длится 45 минут.', [3]);   // цен нет в файле
    const result = await answerKb('сколько стоит мужская стрижка?');
    expect(result.answerable).toBe(false);
  });

  it('model ответила answerable=false — отказ, хоть answer и непустой', async () => {
    modelAnswers(false, 'Такое у нас есть!', [3]);
    const result = await answerKb('сколько стоит мужская стрижка?');
    expect(result.answerable).toBe(false);
  });

  it('модель не указала источники — ответ не на что опереть', async () => {
    modelAnswers(true, 'Мужская стрижка стоит 2000 ₽.', []);
    const result = await answerKb('сколько стоит мужская стрижка?');
    expect(result.answerable).toBe(false);
  });

  it('модель сослалась на чужой id — ответ не проходит', async () => {
    modelAnswers(true, 'Мужская стрижка стоит 2000 ₽.', [99]);
    const result = await answerKb('сколько стоит мужская стрижка?');
    expect(result.answerable).toBe(false);
  });

  it('скорректированная модель: невалидный JSON — отказ', async () => {
    completeMock.mockResolvedValue('Извините, я просто текст, без JSON и цифр…');
    const result = await answerKb('сколько стоит мужская стрижка?');
    expect(result.answerable).toBe(false);
  });

  it('модель недоступна — отказ вместо падения диалога', async () => {
    completeMock.mockRejectedValue(new Error('LLM выключен в тестах'));
    const result = await answerKb('сколько стоит мужская стрижка?');
    expect(result.answerable).toBe(false);
  });
});

describe('numbersOk', () => {
  it('число из фрагмента с пробелом внутри считается валидным', () => {
    expect(numbersOk('Стрижка стоит 2 000 ₽', [CHUNKS[0]])).toBe(true);
  });

  it('число, которого нет во фрагментах, ловится', () => {
    expect(numbersOk('Стрижка стоит 9500 ₽', [CHUNKS[0]])).toBe(false);
  });

  it('вопрос вне фрагмента: цена небось из головы — ловится', () => {
    expect(numbersOk('Сертификат от 2 000 ₽', [CHUNKS[1]])).toBe(false);
  });

  it('ответ без чисел не требует проверки', () => {
    expect(numbersOk('Вход со двора', [CHUNKS[1]])).toBe(true);
  });
});

describe('expandQuery', () => {
  it('добавляет тему адреса к вопросу «где вы находитесь»', () => {
    expect(expandQuery('Где вы находитесь?')).toContain('адрес барбершопа');
  });

  it('добавляет тему адреса к вопросу «как добраться»', () => {
    expect(expandQuery('Как добраться до вас?')).toContain('адрес барбершопа');
  });

  it('не трогает вопрос о цене', () => {
    expect(expandQuery('Сколько стоит стрижка?')).toBe('Сколько стоит стрижка?');
  });
});

describe('порог', () => {
  it('читается из окружения', () => {
    expect(distMax()).toBe(0.6);
  });
});
