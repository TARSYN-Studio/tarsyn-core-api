import { query, logAudit } from '../../db.js';

export default async function cardsRoutes(app) {

  // ── GET /api/finance/cards ────────────────────────────────────
  app.get('/cards', {
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
      `SELECT * FROM corporate_cards WHERE ${conditions.join(' AND ')} ORDER BY card_name ASC`,
      params
    );
    return rows;
  });

  // ── POST /api/finance/cards ───────────────────────────────────
  app.post('/cards', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['card_name'],
        properties: {
          card_name:       { type: 'string', minLength: 1 },
          last_four:       { type: 'string' },
          card_type:       { type: 'string', default: 'visa' },
          current_balance: { type: 'number', default: 0 },
          credit_limit:    { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { card_name, last_four, card_type, current_balance, credit_limit } = request.body;

    const { rows } = await query(
      `INSERT INTO corporate_cards
         (company_id, card_name, last_four, card_type, current_balance, credit_limit)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [company_id, card_name.trim(), last_four ?? null, card_type ?? 'visa',
       current_balance ?? 0, credit_limit ?? 0]
    );

    await logAudit({ companyId: company_id, userId: user_id, action: 'create',
      entityType: 'corporate_card', entityId: rows[0].id, newValues: rows[0] });

    return reply.status(201).send(rows[0]);
  });

  // ── PATCH /api/finance/cards/:id ─────────────────────────────
  app.patch('/cards/:id', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          card_name:       { type: 'string' },
          last_four:       { type: 'string' },
          card_type:       { type: 'string' },
          current_balance: { type: 'number' },
          credit_limit:    { type: 'number' },
          is_active:       { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;

    const { rows: existing } = await query(
      `SELECT * FROM corporate_cards WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) return reply.status(404).send({ error: 'Card not found' });

    const fields = ['card_name','last_four','card_type','current_balance','credit_limit','is_active'];
    const updates = [];
    const params = [];
    let p = 1;
    for (const f of fields) {
      if (request.body[f] !== undefined) { updates.push(`${f} = $${p++}`); params.push(request.body[f]); }
    }
    if (updates.length === 0) return reply.status(400).send({ error: 'No fields to update' });

    params.push(id, company_id);
    const { rows } = await query(
      `UPDATE corporate_cards SET ${updates.join(', ')} WHERE id = $${p} AND company_id = $${p + 1} RETURNING *`,
      params
    );

    await logAudit({ companyId: company_id, userId: user_id, action: 'update',
      entityType: 'corporate_card', entityId: id, oldValues: existing[0], newValues: rows[0] });

    return rows[0];
  });
}
