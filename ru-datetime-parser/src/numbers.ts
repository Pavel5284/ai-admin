/**
 * Числительные словами → цифры. День 4 гайда.
 *
 * Два входа наружу:
 *   findNumbers(text)    — разбивка реплики на числа (группы);
 *   wordsToDigits(text)  — та же реплика, но вместо слов числа.
 *
 * Разница между ними: findNumbers отдаёт токены с границами, wordsToDigits
 * просто подставляет цифры. Всё остальное (даты, время, телефоны) строится
 * поверх findNumbers.
 */

export type NumToken = { value: number; raw: string; ordinal: boolean; start: number; end: number };

type Piece = {
  value: number;
  rank: number;        // разряд: 1 — единицы, 2 — десятки, 3 — сотни, 4 — тысячи
  teen: boolean;       // 10–19: после такого числа новое начинается всегда
  ordinal: boolean;
  start: number;
  end: number;
  raw: string;         // у цифр — исходная строка («056» нельзя превращать в 56)
  digits: boolean;     // пришло ли готовыми цифрами
};

const rankOf = (value: number): number => {
  if (value >= 1000) return 4;
  if (value >= 100) return 3;
  if (value >= 10) return 2;
  return 1;
};

const isTeen = (value: number) => value >= 10 && value <= 19;

/** Количественные числительные во всех нужных падежах. */
const QUANT_WORDS: Record<string, number> = {
  ноль: 0, нуль: 0,
  один: 1, одна: 1, одно: 1, одного: 1, одной: 1, одному: 1, одним: 1, одном: 1,
  два: 2, две: 2, двух: 2, двум: 2, двумя: 2,
  три: 3, трех: 3, трёх: 3, трем: 3, трём: 3, тремя: 3,
  четыре: 4, четырех: 4, четырёх: 4,
  пять: 5, пяти: 5, пятью: 5,
  шесть: 6, шести: 6, шестью: 6,
  семь: 7, семи: 7, семью: 7,
  восемь: 8, восьми: 8, восемью: 8,
  девять: 9, девяти: 9, девятью: 9,
  десять: 10, десяти: 10, десятью: 10,
  одиннадцать: 11, одиннадцати: 11, одиннадцатью: 11,
  двенадцать: 12, двенадцати: 12, двенадцатью: 12,
  тринадцать: 13, тринадцати: 13, тринадцатью: 13,
  четырнадцать: 14, четырнадцати: 14, четырнадцатью: 14,
  пятнадцать: 15, пятнадцати: 15, пятнадцатью: 15,
  шестнадцать: 16, шестнадцати: 16, шестнадцатью: 16,
  семнадцать: 17, семнадцати: 17, семнадцатью: 17,
  восемнадцать: 18, восемнадцати: 18, восемнадцатью: 18,
  девятнадцать: 19, девятнадцати: 19, девятнадцатью: 19,
  двадцать: 20, двадцати: 20, двадцатью: 20,
  тридцать: 30, тридцати: 30, тридцатью: 30,
  сорок: 40, сорока: 40,
  пятьдесят: 50, пятидесяти: 50, пятьдесятью: 50,
  шестьдесят: 60, шестидесяти: 60, шестьдесятью: 60,
  семьдесят: 70, семидесяти: 70, семьдесятью: 70,
  восемьдесят: 80, восьмидесяти: 80, восемьдесятью: 80,
  девяносто: 90, девяноста: 90,
  сто: 100, ста: 100,
  двести: 200, двухсот: 200, двумстам: 200, двухстах: 200,
  триста: 300, трехсот: 300, трёхсот: 300, тремстам: 300,
  четыреста: 400, четырехсот: 400, четырёхсот: 400,
  пятьсот: 500, пятисот: 500,
  шестьсот: 600, шестисот: 600,
  семьсот: 700, семисот: 700, семистах: 700,
  восемьсот: 800, восьмисот: 800,
  девятьсот: 900, девятисот: 900,
  тысяча: 1000, тысячи: 1000, тысяч: 1000,
};

/**
 * Порядковые числительные: основа + окончание.
 * Мягкая основа («треть») требует одних окончаний, твёрдая («перв») — других.
 */
const ORD_STEMS: Array<[string, number]> = [
  ['перв', 1], ['втор', 2], ['треть', 3], ['четверт', 4], ['пят', 5], ['шест', 6],
  ['седьм', 7], ['восьм', 8], ['девят', 9], ['десят', 10],
  ['одиннадцат', 11], ['двенадцат', 12], ['тринадцат', 13], ['четырнадцат', 14],
  ['пятнадцат', 15], ['шестнадцат', 16], ['семнадцат', 17], ['восемнадцат', 18],
  ['девятнадцат', 19], ['двадцат', 20], ['тридцат', 30],
  ['сот', 100],
];

const ORD_ENDINGS_HARD = ['ый', 'ой', 'ая', 'ое', 'ого', 'ому', 'ым', 'ом', 'ей', 'ую', 'ых'];
const ORD_ENDINGS_SOFT = ['ий', 'я', 'е', 'его', 'ему', 'им', 'ем', 'ей', 'ю', 'их'];

const DICT = new Map<string, { value: number; rank: number; teen: boolean; ordinal: boolean }>();

for (const [word, value] of Object.entries(QUANT_WORDS)) {
  DICT.set(word, { value, rank: rankOf(value), teen: isTeen(value), ordinal: false });
}

for (const [stem, value] of ORD_STEMS) {
  const endings = stem.endsWith('ь') ? ORD_ENDINGS_SOFT : ORD_ENDINGS_HARD;
  for (const ending of endings) {
    DICT.set(stem + ending, { value, rank: rankOf(value), teen: isTeen(value), ordinal: true });
  }
}

// Длинные слова проверяем первыми, иначе «три» съест начало «тридцать».
const WORDS = [...DICT.keys()].sort((a, b) => b.length - a.length);
const WORD_RE = new RegExp(
  String.raw`(?<![\p{L}\d])(?:${WORDS.join('|')})(?![\p{L}\d])`,
  'giu',
);
const DIGIT_RE = /(?<![\p{L}\d])\d+(?![\p{L}\d])/gu;

/** Окончание порядкового у цифр: «23-го», «23-е», «23-й». */
const ORD_SUFFIX_RE = /^(?:-\s?)?(го|е|ый|ой|ая|яя|ое|ее|ей|ым|ом|ю|ий|я)(?![\p{L}\d])/u;

function scanWords(text: string): Piece[] {
  const out: Piece[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const info = DICT.get(m[0].toLowerCase());
    if (!info) continue;
    out.push({
      value: info.value, rank: info.rank, teen: info.teen, ordinal: info.ordinal,
      start: m.index!, end: m.index! + m[0].length, raw: String(info.value), digits: false,
    });
  }
  return out;
}

function scanDigits(text: string): Piece[] {
  const out: Piece[] = [];
  for (const m of text.matchAll(DIGIT_RE)) {
    const raw = m[0];
    const value = Number(raw);
    let end = m.index! + raw.length;
    let ordinal = false;

    const suffix = ORD_SUFFIX_RE.exec(text.slice(end));
    if (suffix) {
      end += suffix[0].length;
      ordinal = true;
    }

    out.push({
      value, rank: Math.min(raw.length, 4), teen: isTeen(value), ordinal,
      start: m.index!, end, raw, digits: true,
    });
  }
  return out;
}

/**
 * Правило группировки: слово продолжает текущее число, только если оно «младше»
 * предыдущего по разряду (сотни → десятки → единицы).
 * После числа 10–19 новое число начинается всегда: «без 15 6» — это 15 и 6,
 * а не 21.
 */
function continues(last: Piece, next: Piece): boolean {
  if (last.teen && next.rank === 1) return false;
  return next.rank < last.rank;
}

/** Числа в реплике: словами и готовыми цифрами. */
export function findNumbers(text: string): NumToken[] {
  const pieces = [...scanWords(text), ...scanDigits(text)].sort((a, b) => a.start - b.start);

  const tokens: NumToken[] = [];
  let value = 0;
  let raw = '';
  let ordinal = false;
  let start = 0;
  let end = 0;
  let last: Piece | null = null;

  const flush = () => {
    if (!last) return;
    tokens.push({ value, raw, ordinal, start, end });
  };

  for (const p of pieces) {
    if (last && continues(last, p) && !last.digits) {
      // Продолжаем текущее число: «девятьсот шестнадцать» → 916.
      value += p.value;
      end = p.end;
      ordinal = ordinal || p.ordinal;
      raw = String(value);
    } else {
      flush();
      value = p.value;
      raw = p.digits ? p.raw : String(p.value);
      ordinal = p.ordinal;
      start = p.start;
      end = p.end;
    }
    last = p;
  }
  flush();

  return tokens;
}

/**
 * Заменяет числа словами на цифры.
 *   «двадцать три»        → «23»
 *   «пятнадцать тридцать» → «15 30»
 *   «двадцать третьего»   → «23»   (окончание порядкового отбрасывается)
 *   «без пятнадцати шесть»→ «без 15 6»  (слово «без» — не число, оно остаётся)
 */
export function wordsToDigits(text: string): string {
  const tokens = findNumbers(text);
  if (!tokens.length) return text;

  let out = '';
  let pos = 0;
  for (const t of tokens) {
    if (t.start < pos) continue;              // пересечение — пропускаем
    out += text.slice(pos, t.start) + t.raw;
    pos = t.end;
  }
  return out + text.slice(pos);
}
