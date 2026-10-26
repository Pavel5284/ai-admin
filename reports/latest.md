# Отчёт eval (dev), 2026-10-26 14:27

| Метрика | Значение |
|---|---|
| Сценариев | 98 |
| Task success | 100% (98/98) |
| False-booking | 0 |
| Handoff rate | 9% (9) |
| Handoff оправданный / лишний | 8 / 1 |
| Hallucination rate (RAG) | 0% (0/3 вопросов без ответа) |
| FAQ без ответа | 4 |
| LLM share | 8% (31/367 реплик) |
| Latency p50 / p95 (все) | 10 / 136 мс |
| Latency p50 / p95 (с LLM) | 19 / 980 мс (31 реплик) |
| Latency p50 / p95 (правила) | 10 / 35 мс (336 реплик) |
| Turns to booking | 4.7 |
| Slot accuracy: service | 100% (46/46) |
| Slot accuracy: date | 100% (49/49) |
| Slot accuracy: time | 100% (47/47) |
| Slot accuracy: phone | 100% (46/46) |
| Slot accuracy: name | 100% (60/60) |
| Slot accuracy: masterId | 100% (6/6) |

## По категориям

| Тег | Сценариев | Успех |
|---|---|---|
| ambiguous | 10 | 100% |
| attack | 6 | 100% |
| back | 1 | 100% |
| barge-in | 1 | 100% |
| booking | 48 | 100% |
| cancel | 4 | 100% |
| correction | 7 | 100% |
| crm | 2 | 100% |
| date | 2 | 100% |
| dirty | 17 | 100% |
| edge | 20 | 100% |
| faq | 15 | 100% |
| handoff-justified | 8 | 100% |
| interruption | 1 | 100% |
| kb-answer | 9 | 100% |
| llm | 1 | 100% |
| master | 2 | 100% |
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