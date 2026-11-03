-- Привязка записи к Telegram-аккаунту.
--
-- Старые записи остаются с NULL: их нельзя безопасно связать с аккаунтом
-- задним числом. Бот не показывает их по аккаунту, а отправляет клиента
-- к администратору.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS client_telegram_id bigint;

CREATE INDEX IF NOT EXISTS bookings_client_telegram_id_idx
  ON bookings (client_telegram_id, starts_at);
