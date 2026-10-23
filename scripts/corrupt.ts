/**
 * Детерминированная «порча» чистой реплики для проверки парсера
 * (раздел 4.1 гайда). Seed фиксирован, поэтому один и тот же вызов
 * всегда даёт один и тот же результат.
 */

const FILLERS = ['ну', 'эээ', 'ммм', 'короче', 'значит', 'вот', 'это самое'];
const NUM_WORDS: Record<string, string> = {
  '3': 'три', '5': 'пять', '6': 'шесть', '15': 'пятнадцать', '18': 'восемнадцать', '30': 'тридцать',
};

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function corrupt(text: string, seed: number): string {
  const rand = mulberry32(seed);
  const pick = (n: number) => Math.floor(rand() * n);
  const words = text.toLowerCase().replace(/[.,!?]/g, '').split(/\s+/);
  const ops = [
    // вставить слово-паразит
    () => { words.splice(pick(words.length), 0, FILLERS[pick(FILLERS.length)]); },
    // выбросить букву из длинного слова
    () => {
      const i = pick(words.length);
      if (words[i].length > 4) {
        const j = 1 + pick(words[i].length - 2);
        words[i] = words[i].slice(0, j) + words[i].slice(j + 1);
      }
    },
    // склеить два соседних слова
    () => { if (words.length > 2) { const i = pick(words.length - 1); words.splice(i, 2, words[i] + words[i + 1]); } },
    // заменить цифры словами
    () => { for (let i = 0; i < words.length; i++) words[i] = NUM_WORDS[words[i]] ?? words[i]; },
  ];
  for (let k = 0, n = 1 + pick(3); k < n; k++) ops[pick(ops.length)]();
  return words.join(' ');
}
