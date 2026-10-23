# Отчёт eval (dev), 2026-10-23 02:09

| Метрика | Значение |
|---|---|
| Сценариев | 97 |
| Task success | 100% (97/97) |
| False-booking | 0 |
| Handoff rate | 9% (9) |
| Handoff оправданный / лишний | 8 / 1 |
| Hallucination rate (RAG) | 0% (0/3 вопросов без ответа) |
| FAQ без ответа | 4 |
| LLM share | 10% (31/304 реплик) |
| Latency p50 / p95 (все) | 11 / 283 мс |
| Latency p50 / p95 (с LLM) | 23 / 881 мс (31 реплик) |
| Latency p50 / p95 (правила) | 10 / 34 мс (273 реплик) |
| Turns to booking | 3.7 |
| Slot accuracy: service | 100% (46/46) |
| Slot accuracy: date | 100% (49/49) |
| Slot accuracy: time | 100% (47/47) |
| Slot accuracy: phone | 100% (46/46) |
| Slot accuracy: masterId | 100% (5/5) |
| Slot accuracy: name | 100% (2/2) |

## По категориям

| Тег | Сценариев | Успех |
|---|---|---|
| ambiguous | 10 | 100% |
| attack | 6 | 100% |
| back | 1 | 100% |
| barge-in | 1 | 100% |
| booking | 48 | 100% |
| cancel | 4 | 100% |
| correction | 6 | 100% |
| crm | 2 | 100% |
| date | 2 | 100% |
| dirty | 17 | 100% |
| edge | 19 | 100% |
| faq | 15 | 100% |
| handoff-justified | 8 | 100% |
| interruption | 1 | 100% |
| kb-answer | 9 | 100% |
| llm | 1 | 100% |
| master | 1 | 100% |
| multiple | 2 | 100% |
| no-answer | 3 | 100% |
| non-text | 1 | 100% |
| not-found | 3 | 100% |
| not-understood | 2 | 100% |
| offtopic | 1 | 100% |
| outbox | 2 | 100% |
| perfect | 10 | 100% |
| phone | 8 | 100% |
| range | 1 | 100% |
| repeat | 1 | 100% |
| reschedule | 8 | 100% |
| resume | 1 | 100% |
| silence | 1 | 100% |
| slot-taken | 1 | 100% |
| slots | 1 | 100% |
| system-failure | 6 | 100% |
| time | 1 | 100% |
| two-intents | 1 | 100% |

## Упавшие сценарии

Все сценарии прошли.