import { normalize } from '../src/normalize';
import { parseWhen } from '../src/dates';
import { parsePhone } from '../src/phone';

// «Сегодня» всегда передаётся снаружи: внутри библиотеки нет new Date().
const now = new Date(2026, 9, 15, 12, 0); // четверг, 15 октября 2026, 12:00

const phrases = [
  'ну эээ подстричься послезавтра часа в три',
  'на следующей неделе, нет, в субботу в половине шестого',
  'без пятнадцати шесть',
  'мой номер восемь девятьсот шестнадцать двести тридцать четыре пятьдесят шесть семьдесят восемь',
];

for (const phrase of phrases) {
  const text = normalize(phrase);
  console.log('\nФраза:', phrase);
  console.log('Нормализация:', text);
  console.log('Дата/время:', parseWhen(text, now));
  console.log('Телефон:', parsePhone(phrase));
}
