import { query, logAudit } from '../../db.js';

export default async function categoriesRoutes(app) {

  // ── GET /api/finance/categories ───────────────────────────────
  app.get('/categories', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          is_active: { type: 'boolean' },
        },
      },
    },
  }, async (request, _reply) => {
    const { company_id } = request.user;
    const { is_active } = request.query;

    const conditions = ['company_id = $1'];
    const params = [company_id];
    if (is_active !== undefined) { conditions.push(`is_active = $2`); params.push(is_active); }

    const { rows } = await query(
      `SELECT * FROM expense_categories WHERE ${conditions.join(' AND ')} ORDER BY name ASC`,
      params
    );
    return rows;
  });

  // ── POST /api/finance/categories ──────────────────────────────
  app.post('/categories', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name:    { type: 'string', minLength: 1 },
          name_ar: { type: 'string' },
          code:    { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { name, name_ar, code } = request.body;

    const { rows } = await query(
      `INSERT INTO expense_categories (company_id, name, name_ar, code)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [company_id, name.trim(), name_ar ?? null, code ?? null]
    );

    await logAudit({ companyId: company_id, userId: user_id, action: 'create',
      entityType: 'expense_category', entityId: rows[0].id, newValues: rows[0] });

    return reply.status(201).send(rows[0]);
  });

  // ── PATCH /api/finance/categories/:id ─────────────────────────
  app.patch('/categories/:id', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          name:      { type: 'string' },
          name_ar:   { type: 'string' },
          code:      { type: 'string' },
          is_active: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;

    const { rows: existing } = await query(
      `SELECT * FROM expense_categories WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) return reply.status(404).send({ error: 'Category not found' });

    const fields = ['name','name_ar','code','is_active'];
    const updates = [];
    const params = [];
    let p = 1;
    for (const f of fields) {
      if (request.body[f] !== undefined) { updates.push(`${f} = $${p++}`); params.push(request.body[f]); }
    }
    if (updates.length === 0) return reply.status(400).send({ error: 'No fields to update' });

    params.push(id, company_id);
    const { rows } = await query(
      `UPDATE expense_categories SET ${updates.join(', ')} WHERE id = $${p} AND company_id = $${p + 1} RETURNING *`,
      params
    );

    await logAudit({ companyId: company_id, userId: user_id, action: 'update',
      entityType: 'expense_category', entityId: id, oldValues: existing[0], newValues: rows[0] });

    return rows[0];
  });
}
