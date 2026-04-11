import { query } from '../../db.js';

export default async function notificationsRoutes(app) {

  // ── GET /api/finance/notifications ───────────────────────────
  // Returns unread notifications for the current user
  app.get('/notifications', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          unread_only: { type: 'boolean', default: false },
          limit:       { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
      },
    },
  }, async (request, _reply) => {
    const { company_id, sub: user_id } = request.user;
    const { unread_only, limit } = request.query;

    const conditions = ['company_id = $1', 'user_id = $2'];
    const params = [company_id, user_id];
    if (unread_only) { conditions.push('is_read = false'); }
    params.push(limit);

    const { rows } = await query(
      `SELECT * FROM notifications
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );
    return rows;
  });

  // ── PATCH /api/finance/notifications/:id/read ─────────────────
  app.patch('/notifications/:id/read', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;

    const { rows } = await query(
      `UPDATE notifications SET is_read = true
       WHERE id = $1 AND company_id = $2 AND user_id = $3
       RETURNING *`,
      [id, company_id, user_id]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Notification not found' });
    return rows[0];
  });

  // ── POST /api/finance/notifications ──────────────────────────
  // Internal endpoint — create a notification for a user
  app.post('/notifications', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['user_id', 'title'],
        properties: {
          user_id:     { type: 'string' },
          title:       { type: 'string', minLength: 1 },
          message:     { type: 'string' },
          type:        { type: 'string', enum: ['info','success','warning','error','approval'], default: 'info' },
          entity_type: { type: 'string' },
          entity_id:   { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { user_id, title, message, type, entity_type, entity_id } = request.body;

    const { rows } = await query(
      `INSERT INTO notifications
         (company_id, user_id, title, message, type, entity_type, entity_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [company_id, user_id, title, message ?? null, type ?? 'info',
       entity_type ?? null, entity_id ?? null]
    );
    return reply.status(201).send(rows[0]);
  });
}
