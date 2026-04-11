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

pool.query('SELECT 1').then(() => {
  console.log('[DB] PostgreSQL connected — tarsyn_netaj');
}).catch((err) => {
  console.error('[DB] Connection failed:', err.message);
  process.exit(1);
});

export async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run multiple queries inside a single transaction.
 * Automatically commits on success, rolls back on any error.
 *
 * Usage:
 *   const result = await withTransaction(async (client) => {
 *     await client.query('INSERT ...');
 *     await client.query('UPDATE ...');
 *     return someValue;
 *   });
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
