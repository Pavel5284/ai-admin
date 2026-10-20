CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE services (
                        id           serial PRIMARY KEY,
                        code         text UNIQUE NOT NULL,          -- 'haircut', 'beard'
                        title        text NOT NULL,
                        synonyms     text[] NOT NULL DEFAULT '{}',  -- {стрижка,подстричься}
                        duration_min int NOT NULL,
                        price        int NOT NULL
);

CREATE TABLE masters (
                       id serial PRIMARY KEY, name text NOT NULL, active boolean NOT NULL DEFAULT true
);

CREATE TABLE master_services (
                               master_id  int REFERENCES masters(id),
                               service_id int REFERENCES services(id),
                               PRIMARY KEY (master_id, service_id)
);

CREATE TABLE work_schedule (
                             master_id  int REFERENCES masters(id),
                             weekday    int NOT NULL CHECK (weekday BETWEEN 1 AND 7),  -- 1 = понедельник
                             start_time time NOT NULL,
                             end_time   time NOT NULL,
                             PRIMARY KEY (master_id, weekday)
);

CREATE TABLE bookings (
                        id           serial PRIMARY KEY,
                        master_id    int NOT NULL REFERENCES masters(id),
                        service_id   int NOT NULL REFERENCES services(id),
                        starts_at    timestamptz NOT NULL,
                        ends_at      timestamptz NOT NULL,
                        client_name  text,
                        client_phone text NOT NULL,
                        status       text NOT NULL DEFAULT 'confirmed',   -- confirmed / cancelled
                        crm_id       text,
                        created_at   timestamptz NOT NULL DEFAULT now()
);

-- БД сама не даст записать двух клиентов к одному мастеру на одно время
ALTER TABLE bookings ADD CONSTRAINT no_overlap
  EXCLUDE USING gist (master_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
  WHERE (status = 'confirmed');


CREATE TABLE sessions (
                        session_id text PRIMARY KEY,
                        ctx        jsonb NOT NULL,
                        updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dialog_log (
                          id         bigserial PRIMARY KEY,
                          ts         timestamptz NOT NULL DEFAULT now(),
                          session_id text NOT NULL,
                          state_from text,
                          state_to   text,
                          user_text  text,
                          nlu        jsonb,
                          bot_text   text,
                          latency_ms int
);

CREATE TABLE crm_outbox (
                          id          bigserial PRIMARY KEY,
                          payload     jsonb NOT NULL,
                          attempts    int NOT NULL DEFAULT 0,
                          next_try_at timestamptz NOT NULL DEFAULT now(),
                          done        boolean NOT NULL DEFAULT false
);

CREATE TABLE kb_chunks (
                         id        serial PRIMARY KEY,
                         source    text NOT NULL,
                         title     text NOT NULL,
                         text      text NOT NULL,
                         embedding vector(1024)    -- 1024 у mistral-embed; у другой модели размерность другая
);
