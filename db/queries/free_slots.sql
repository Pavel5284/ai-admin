-- Свободные окна на дату: сетка времени по графику мастеров минус занятые интервалы.
--
-- Параметры:
--   $1 — код услуги ('haircut')
--   $2 — дата ('2026-10-21')
--   $3 — текущее время. Именно параметр, а не now(): иначе сценарии
--        с фиксированной датой давали бы разные слоты в разные дни.
--   $4 — мастер (NULL — любой свободный).
--
-- Таймзона берётся из настроек соединения (Europe/Moscow, D-006).
-- В psql её нужно задать вручную, иначе слоты «поедут» на три часа:
SET timezone = 'Europe/Moscow';
--
-- Запуск:
--   docker compose exec db psql -U app -d admin
--   \i db/queries/free_slots.sql
--   EXECUTE free_slots('haircut', current_date + 1, now(), NULL);

PREPARE free_slots(text, date, timestamptz, int) AS
SELECT m.id AS master_id, m.name, to_char(s.slot_start, 'HH24:MI') AS slot_time
FROM services sv
         JOIN master_services ms ON ms.service_id = sv.id
         JOIN masters m          ON m.id = ms.master_id AND m.active
         JOIN work_schedule ws   ON ws.master_id = m.id
                                AND ws.weekday = EXTRACT(ISODOW FROM $2::date)
         CROSS JOIN LATERAL generate_series(
             $2::date + ws.start_time,
             $2::date + ws.end_time - make_interval(mins => sv.duration_min),
             interval '30 minutes'
             ) AS s(slot_start)
WHERE sv.code = $1
  AND s.slot_start > $3::timestamptz
  AND ($4::int IS NULL OR m.id = $4)
  AND NOT EXISTS (
    SELECT 1
    FROM bookings b
    WHERE b.master_id = m.id
      AND b.status = 'confirmed'
      AND tstzrange(b.starts_at, b.ends_at)
          && tstzrange(s.slot_start, s.slot_start + make_interval(mins => sv.duration_min))
  )
ORDER BY s.slot_start, m.id;

-- Ожидание: занятые часы Артёма и Руслана на завтра в выдаче отсутствуют,
-- а у Руслана в понедельник слотов нет — у него выходной.
