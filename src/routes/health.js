import { pool } from '../db.js';

export default async function healthRoutes(app) {
  app.get('/health', async (_request, _reply) => {
    let dbStatus = 'ok';
    let dbLatencyMs = null;
    let dbVersion = null;

    try {
      const start = Date.now();
      const result = await pool.query('SELECT version()');
      dbLatencyMs = Date.now() - start;
      dbVersion = result.rows[0].version.split(' ').slice(0, 2).join(' ');
    } catch (err) {
      dbStatus = `error: ${err.message}`;
    }

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'tarsyn-core-api',
      version: '1.0.0',
      database: {
        status: dbStatus,
        latency_ms: dbLatencyMs,
        version: dbVersion,
      },
    };
  });
}
