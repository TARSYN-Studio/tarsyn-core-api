import { query } from '../db.js';

export default async function settingsRoutes(app) {

  // ── GET /api/company-settings ─────────────────────────────────
  app.get('/company-settings', {
    preHandler: [app.authenticate],
  }, async (request, _reply) => {
    const { company_id } = request.user;

    const { rows } = await query(
      `SELECT key, value, description, updated_at
       FROM company_settings
       WHERE company_id = $1
       ORDER BY key`,
      [company_id]
    );

    return { data: rows };
  });

  // ── POST /company-settings/upsert ─────────────────────────────
  app.post('/company-settings/upsert', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    const { key, value } = req.body;
    const { rows } = await query(
      `INSERT INTO company_settings (company_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value
       RETURNING *`,
      [company_id, key, value]
    );
    return rows[0];
  });
}
