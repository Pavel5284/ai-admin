import 'dotenv/config';
import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c timezone=' + (process.env.BUSINESS_TZ ?? 'Europe/Moscow'),  // таймзона бизнеса
});
