import { query } from '../../db.js';

export default async function authExtrasRoutes(app) {

  // ── GET /api/auth/module-permissions ─────────────────────────
  // Returns all module permissions for current user
  app.get('/module-permissions', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { sub: user_id, company_id } = request.user;
    const { rows } = await query(
      `SELECT module, access_level FROM module_permissions
       WHERE user_id = $1 AND company_id = $2`,
      [user_id, company_id]
    );
    return { data: rows };
  });

  // ── PUT /api/auth/module-permissions ─────────────────────────
  // Bulk upsert permissions for current user (admin use)
  app.put('/module-permissions', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { sub: user_id, company_id } = request.user;
    const { permissions } = request.body; // [{ module, access_level }]
    if (!Array.isArray(permissions)) {
      return reply.status(400).send({ error: 'permissions must be an array' });
    }
    for (const p of permissions) {
      await query(
        `INSERT INTO module_permissions (user_id, company_id, module, access_level)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, company_id, module) DO UPDATE SET access_level = EXCLUDED.access_level`,
        [user_id, company_id, p.module, p.access_level]
      );
    }
    return { success: true };
  });

  // ── GET /api/auth/config ──────────────────────────────────────
  // Returns auth config from global_config
  app.get('/config', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT key, value FROM global_config WHERE company_id = $1 ORDER BY key`,
      [company_id]
    );
    const config = {};
    for (const row of rows) config[row.key] = row.value;
    return config;
  });

  // ── PUT /api/auth/config ──────────────────────────────────────
  app.put('/config', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const entries = Object.entries(request.body);
    for (const [key, value] of entries) {
      await query(
        `INSERT INTO global_config (company_id, key, value, updated_at)
         VALUES ($1,$2,$3,now())
         ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [company_id, key, value]
      );
    }
    return { success: true, updated: entries.length };
  });

  // ── GET /api/auth/security-logs ──────────────────────────────
  app.get('/security-logs', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { limit = 100, offset = 0, from, to } = request.query;

    const conditions = ['a.company_id = $1'];
    const params = [company_id];
    let p = 2;
    if (from) { conditions.push(`a.created_at >= $${p++}`); params.push(from); }
    if (to)   { conditions.push(`a.created_at <= $${p++}`); params.push(to);   }
    params.push(limit, offset);

    const { rows } = await query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id,
              a.ip_address, a.reason, a.created_at,
              u.email AS user_email, u.full_name AS user_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    return { data: rows, limit: parseInt(limit), offset: parseInt(offset) };
  });
}
