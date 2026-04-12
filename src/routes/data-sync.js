import { query } from '../db.js';

export default async function dataSyncRoutes(app) {

  // ── Google Sheets config ──────────────────────────────────────
  app.get('/google-sheets-config', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT id, table_name, sheet_tab_name, sync_enabled, last_sync_at
       FROM google_sheets_config WHERE company_id = $1 ORDER BY table_name`,
      [company_id]
    );
    return rows;
  });

  app.patch('/google-sheets-config/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { sync_enabled } = request.body;
    await query(
      `UPDATE google_sheets_config SET sync_enabled = $1 WHERE id = $2 AND company_id = $3`,
      [sync_enabled, id, company_id]
    );
    return { success: true };
  });

  // ── Integration settings ──────────────────────────────────────
  app.get('/integration-settings', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT id, config_key, config_value, category, description, is_secret, is_active, updated_at
       FROM integration_settings WHERE company_id = $1 ORDER BY config_key`,
      [company_id]
    );
    return rows;
  });

  app.post('/integration-settings', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: updated_by } = request.user;
    const settings = request.body; // array of {config_key, config_value, category, description, is_secret, is_active}

    for (const s of settings) {
      await query(
        `INSERT INTO integration_settings (company_id, config_key, config_value, category, description, is_secret, is_active, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (company_id, config_key) DO UPDATE SET
           config_value = EXCLUDED.config_value,
           is_active    = EXCLUDED.is_active,
           updated_at   = now(),
           updated_by   = EXCLUDED.updated_by`,
        [company_id, s.config_key, s.config_value ?? null, s.category ?? null,
         s.description ?? null, s.is_secret ?? false, s.is_active ?? false, updated_by]
      );
    }

    return { success: true, updated: settings.length };
  });

  // ── Sync triggers (stubs — functionality requires server-side jobs) ──
  app.post('/sync-google-sheets', { preHandler: [app.authenticate] }, async (request, reply) => {
    return reply.status(501).send({ error: 'Google Sheets sync requires a server-side job. Configure via cron or admin panel.' });
  });

  app.post('/sync-external-supabase', { preHandler: [app.authenticate] }, async (request, reply) => {
    return reply.status(501).send({ error: 'External Supabase sync is not available in this deployment.' });
  });

  // ── Auth config ───────────────────────────────────────────────
  app.get('/auth-config', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT id, key, value, updated_at FROM auth_config WHERE company_id = $1 ORDER BY key`,
      [company_id]
    );
    return rows;
  });

  app.patch('/auth-config', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: updated_by } = request.user;
    const { key, value } = request.body;

    await query(
      `INSERT INTO auth_config (company_id, key, value, updated_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [company_id, key, JSON.stringify(value), updated_by]
    );

    return { success: true };
  });
}
