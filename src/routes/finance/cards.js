import { query, logAudit } from '../../db.js';

export default async function cardsRoutes(app) {

  // ── Shared handler ─────────────────────────────────────────────
  async function getCorporateCards(company_id, is_active) {
    const conditions = ['company_id = $1'];
    const params = [company_id];
    if (is_active !== undefined) { conditions.push(`is_active = $2`); params.push(is_active); }
    const { rows } = await query(
      `SELECT * FROM corporate_cards WHERE ${conditions.join(' AND ')} ORDER BY card_name ASC`,
      params
    );
    return rows;
  }

  // ── GET /api/finance/cards (legacy) ──────────────────────────
  app.get('/cards', {
    preHandler: [app.authenticate],
    schema: { querystring: { type: 'object', properties: { is_active: { type: 'boolean' } } } },
  }, async (request, _reply) => {
    const { company_id } = request.user;
    return getCorporateCards(company_id, request.query.is_active);
  });

  // ── GET /api/finance/corporate-cards ─────────────────────────
  app.get('/corporate-cards', {
    preHandler: [app.authenticate],
    schema: { querystring: { type: 'object', properties: { is_active: { type: 'boolean' } } } },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const rows = await getCorporateCards(company_id, request.query.is_active);
    return reply.send({ data: rows });
  });

  // ── POST /api/finance/corporate-cards ────────────────────────
  app.post('/corporate-cards', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['card_name'],
        properties: {
          card_name:      { type: 'string', minLength: 1 },
          last_four:      { type: 'string' },
          assigned_to:    { type: 'string' },
          spending_limit: { type: 'number', default: 0 },
          currency:       { type: 'string', default: 'SAR' },
          card_type:      { type: 'string', default: 'visa' },
          is_active:      { type: 'boolean', default: true },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { card_name, last_four, assigned_to, spending_limit, currency, card_type, is_active } = request.body;
    const { rows } = await query(
      `INSERT INTO corporate_cards
         (company_id, card_name, last_four, assigned_to, spending_limit, currency, card_type, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [company_id, card_name.trim(), last_four ?? null, assigned_to ?? null,
       spending_limit ?? 0, currency ?? 'SAR', card_type ?? 'visa', is_active ?? true]
    );
    await logAudit({ companyId: company_id, userId: user_id, action: 'create',
      entityType: 'corporate_card', entityId: rows[0].id, newValues: rows[0] });
    return reply.status(201).send(rows[0]);
  });

  // ── PUT /api/finance/corporate-cards/:id ─────────────────────
  app.put('/corporate-cards/:id', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          card_name:      { type: 'string' },
          last_four:      { type: 'string' },
          assigned_to:    { type: 'string' },
          spending_limit: { type: 'number' },
          currency:       { type: 'string' },
          card_type:      { type: 'string' },
          is_active:      { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;
    const { rows: existing } = await query(
      `SELECT * FROM corporate_cards WHERE id = $1 AND company_id = $2`, [id, company_id]
    );
    if (!existing.length) return reply.status(404).send({ error: 'Card not found' });

    const allowed = ['card_name','last_four','assigned_to','spending_limit','currency','card_type','is_active'];
    const updates = []; const params = []; let p = 1;
    for (const f of allowed) {
      if (request.body[f] !== undefined) { updates.push(`${f} = $${p++}`); params.push(request.body[f]); }
    }
    if (!updates.length) return reply.status(400).send({ error: 'No fields to update' });
    params.push(id, company_id);
    const { rows } = await query(
      `UPDATE corporate_cards SET ${updates.join(', ')} WHERE id = $${p} AND company_id = $${p+1} RETURNING *`,
      params
    );
    await logAudit({ companyId: company_id, userId: user_id, action: 'update',
      entityType: 'corporate_card', entityId: id, oldValues: existing[0], newValues: rows[0] });
    return rows[0];
  });

  // ── DELETE /api/finance/corporate-cards/:id ──────────────────
  app.delete('/corporate-cards/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;
    const { rows: existing } = await query(
      `SELECT * FROM corporate_cards WHERE id = $1 AND company_id = $2`, [id, company_id]
    );
    if (!existing.length) return reply.status(404).send({ error: 'Card not found' });
    await query(`DELETE FROM corporate_cards WHERE id = $1 AND company_id = $2`, [id, company_id]);
    await logAudit({ companyId: company_id, userId: user_id, action: 'delete',
      entityType: 'corporate_card', entityId: id, oldValues: existing[0] });
    return reply.status(204).send();
  });

  // ── POST /api/finance/cards (legacy) ─────────────────────────
  app.post('/cards', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['card_name'],
        properties: {
          card_name:       { type: 'string', minLength: 1 },
          last_four:       { type: 'string' },
          assigned_to:     { type: 'string' },
          spending_limit:  { type: 'number', default: 0 },
          currency:        { type: 'string', default: 'SAR' },
          card_type:       { type: 'string', default: 'visa' },
          current_balance: { type: 'number', default: 0 },
          credit_limit:    { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { card_name, last_four, assigned_to, spending_limit, currency, card_type, current_balance, credit_limit } = request.body;
    const { rows } = await query(
      `INSERT INTO corporate_cards
         (company_id, card_name, last_four, assigned_to, spending_limit, currency, card_type, current_balance, credit_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [company_id, card_name.trim(), last_four ?? null, assigned_to ?? null,
       spending_limit ?? 0, currency ?? 'SAR', card_type ?? 'visa', current_balance ?? 0, credit_limit ?? 0]
    );
    await logAudit({ companyId: company_id, userId: user_id, action: 'create',
      entityType: 'corporate_card', entityId: rows[0].id, newValues: rows[0] });
    return reply.status(201).send(rows[0]);
  });

  // ── PATCH /api/finance/cards/:id (legacy) ────────────────────
  app.patch('/cards/:id', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          card_name:       { type: 'string' },
          last_four:       { type: 'string' },
          assigned_to:     { type: 'string' },
          spending_limit:  { type: 'number' },
          currency:        { type: 'string' },
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
      `SELECT * FROM corporate_cards WHERE id = $1 AND company_id = $2`, [id, company_id]
    );
    if (!existing.length) return reply.status(404).send({ error: 'Card not found' });

    const allowed = ['card_name','last_four','assigned_to','spending_limit','currency','card_type','current_balance','credit_limit','is_active'];
    const updates = []; const params = []; let p = 1;
    for (const f of allowed) {
      if (request.body[f] !== undefined) { updates.push(`${f} = $${p++}`); params.push(request.body[f]); }
    }
    if (!updates.length) return reply.status(400).send({ error: 'No fields to update' });
    params.push(id, company_id);
    const { rows } = await query(
      `UPDATE corporate_cards SET ${updates.join(', ')} WHERE id = $${p} AND company_id = $${p+1} RETURNING *`,
      params
    );
    await logAudit({ companyId: company_id, userId: user_id, action: 'update',
      entityType: 'corporate_card', entityId: id, oldValues: existing[0], newValues: rows[0] });
    return rows[0];
  });

  // ── DELETE /api/finance/cards/:id (legacy) ───────────────────
  app.delete('/cards/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;
    const { rows: existing } = await query(
      `SELECT * FROM corporate_cards WHERE id = $1 AND company_id = $2`, [id, company_id]
    );
    if (!existing.length) return reply.status(404).send({ error: 'Card not found' });
    await query(`DELETE FROM corporate_cards WHERE id = $1 AND company_id = $2`, [id, company_id]);
    await logAudit({ companyId: company_id, userId: user_id, action: 'delete',
      entityType: 'corporate_card', entityId: id, oldValues: existing[0] });
    return reply.status(204).send();
  });
}
