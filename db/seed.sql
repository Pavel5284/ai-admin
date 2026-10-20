SET timezone = 'Europe/Moscow';

INSERT INTO services (code, title, synonyms, duration_min, price) VALUES
                                                                    ('haircut', 'Мужская стрижка',    '{стрижк,стрижечк,подстр,постр,стрич}', 60, 2000),
                                                                    ('beard',   'Оформление бороды',  '{бород,усы,усов,подровн}',             30, 1200),
                                                                    ('combo',   'Стрижка + борода',   '{комплекс,обе,все вместе}',            90, 3000),
                                                                    ('kids',    'Детская стрижка',    '{детск,ребен,сын,дочк}',               45, 1500),
                                                                    ('shave',   'Королевское бритьё', '{бритье,побрить,бритв}',               45, 1800),
                                                                    ('styling', 'Укладка',            '{укладк,уложит}',                      30,  800);

INSERT INTO masters (name) VALUES ('Артём'), ('Руслан'), ('Диана');

-- Артём и Руслан делают всё (Руслан без детских), Диана: стрижки, детские, укладка
INSERT INTO master_services (master_id, service_id)
SELECT m.id, s.id FROM masters m JOIN services s ON
  m.name = 'Артём'
    OR (m.name = 'Руслан' AND s.code <> 'kids')
    OR (m.name = 'Диана'  AND s.code IN ('haircut', 'kids', 'styling'));

INSERT INTO work_schedule (master_id, weekday, start_time, end_time)
SELECT m.id, u.d, t.s, t.e
FROM masters m
       JOIN (VALUES
               ('Артём',  ARRAY[1,2,3,4,5,6], TIME '10:00', TIME '19:00'),
               ('Руслан', ARRAY[2,3,4,5,6,7], TIME '12:00', TIME '21:00'),
               ('Диана',  ARRAY[1,3,5,6],     TIME '10:00', TIME '18:00')
) AS t(name, days, s, e) ON t.name = m.name
       CROSS JOIN LATERAL unnest(t.days) AS u(d);

-- несколько существующих записей, чтобы слоты были неидеальными (даты считаются от сегодняшнего дня)
INSERT INTO bookings (master_id, service_id, starts_at, ends_at, client_name, client_phone)
SELECT m.id, s.id, v.ts, v.ts + make_interval(mins => s.duration_min), v.cname, v.phone
FROM (VALUES
        ('Артём',  'haircut', date_trunc('day', now()) + interval '1 day 11 hours',  'Иван',   '+79160000001'),
        ('Артём',  'beard',   date_trunc('day', now()) + interval '1 day 14 hours',  'Павел',  '+79160000002'),
        ('Руслан', 'combo',   date_trunc('day', now()) + interval '1 day 15 hours',  'Олег',   '+79160000003'),
        ('Руслан', 'haircut', date_trunc('day', now()) + interval '2 days 13 hours', 'Максим', '+79160000004'),
        ('Артём',  'haircut', date_trunc('day', now()) + interval '2 days 16 hours', 'Денис',  '+79160000005'),
        ('Диана',  'kids',    date_trunc('day', now()) + interval '3 days 12 hours', 'Анна',   '+79160000006')
     ) AS v(master, service, ts, cname, phone)
       JOIN masters m ON m.name = v.master
       JOIN services s ON s.code = v.service;
