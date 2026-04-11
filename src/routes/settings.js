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
}
