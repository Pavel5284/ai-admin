-- Фиксированное состояние расписания для прогона eval.
-- «Сегодня» во всех сценариях — четверг, 15 октября 2026, 12:00 (см. now в YAML).
-- Телефоны +791600000xx принадлежат фикстуре; записи, созданные ботом,
-- раннер отличает по префиксу клиентского номера.

DELETE FROM bookings;

INSERT INTO bookings (master_id, service_id, starts_at, ends_at, client_name, client_phone)
SELECT m.id, s.id, v.ts::timestamptz, v.ts::timestamptz + make_interval(mins => s.duration_min),
       v.cname, v.phone
FROM (VALUES
  ('Артём',  'haircut', '2026-10-16 11:00+03', 'Иван',   '+79160000001'),
  ('Артём',  'beard',   '2026-10-16 14:00+03', 'Павел',  '+79160000002'),
  ('Руслан', 'combo',   '2026-10-16 15:00+03', 'Олег',   '+79160000003'),
  ('Руслан', 'haircut', '2026-10-17 13:00+03', 'Максим', '+79160000004'),
  ('Артём',  'haircut', '2026-10-17 16:00+03', 'Денис',  '+79160000005'),
  ('Диана',  'kids',    '2026-10-19 12:00+03', 'Анна',   '+79160000006')
) AS v(master, service, ts, cname, phone)
JOIN masters m ON m.name = v.master
JOIN services s ON s.code = v.service;
