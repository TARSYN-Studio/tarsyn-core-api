import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client:', err.message);
});

// Test connection on startup
pool.query('SELECT 1').then(() => {
  console.log('[DB] PostgreSQL connected — tarsyn_netaj');
}).catch((err) => {
  console.error('[DB] Connection failed:', err.message);
  process.exit(1);
});

export async function query(text, params) {
  return pool.query(text, params);
}
