import { query } from '../db.js';

export default async function contractsRoutes(app) {

  // ── GET /api/contracts ────────────────────────────────────────
  app.get('/contracts', { preHandler: [app.authenticate] }, async (request, _reply) => {
    const { company_id } = request.user;
    const { status, client_id } = request.query;

    const conditions = ['c.company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (status)    { conditions.push(`c.status = $${p++}`); params.push(status); }
    if (client_id) { conditions.push(`c.parent_client_id = $${p++}`); params.push(client_id); }

    const { rows } = await query(
      `SELECT c.*,
              cl.name AS client_name,
              cl.country AS client_country,
              (SELECT COUNT(*) FROM purchase_orders po WHERE po.contract_id = c.id AND po.company_id = $1) AS po_count
       FROM contracts c
       LEFT JOIN clients cl ON cl.id = c.parent_client_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY c.created_at DESC`,
      params
    );
    return { data: rows };
  });

  // ── GET /api/contracts/:id ────────────────────────────────────
  app.get('/contracts/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;

    const { rows } = await query(
      `SELECT c.*,
              cl.name AS client_name,
              cl.country AS client_country,
              cl.client_type
       FROM contracts c
       LEFT JOIN clients cl ON cl.id = c.parent_client_id
       WHERE c.id = $1 AND c.company_id = $2`,
      [id, company_id]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Contract not found' });

    const { rows: pos } = await query(
      `SELECT po.*,
              cl.name AS client_name,
              cl.country AS client_country
       FROM purchase_orders po
       LEFT JOIN clients cl ON cl.id = po.client_id
       WHERE po.contract_id = $1 AND po.company_id = $2
       ORDER BY po.created_at DESC`,
      [id, company_id]
    );

    return { ...rows[0], purchase_orders: pos };
  });

  // ── POST /api/contracts ───────────────────────────────────────
  app.post('/contracts', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['parent_client_id', 'total_mt', 'price_per_mt', 'start_date', 'end_date'],
        properties: {
          parent_client_id:      { type: 'string' },
          contract_number:       { type: 'string' },
          total_mt:              { type: 'number', exclusiveMinimum: 0 },
          price_per_mt:          { type: 'number', exclusiveMinimum: 0 },
          currency:              { type: 'string', default: 'USD' },
          start_date:            { type: 'string' },
          end_date:              { type: 'string' },
          payment_terms:         { type: 'string', enum: ['spot', '60_days', 'custom'], default: 'spot' },
          payment_schedule_dates:{ type: 'array', items: { type: 'integer' } },
          payment_currency:      { type: 'string', default: 'USD' },
          notes:                 { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const {
      parent_client_id, contract_number, total_mt, price_per_mt,
      currency = 'USD', start_date, end_date,
      payment_terms = 'spot', payment_schedule_dates, payment_currency = 'USD', notes,
    } = request.body;

    const { rows } = await query(
      `INSERT INTO contracts
         (company_id, parent_client_id, contract_number, total_mt, remaining_mt,
          price_per_mt, currency, start_date, end_date,
          payment_terms, payment_schedule_dates, payment_currency, notes)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [company_id, parent_client_id, contract_number ?? null, total_mt,
       price_per_mt, currency, start_date, end_date,
       payment_terms, payment_schedule_dates ?? null, payment_currency, notes ?? null]
    );

    // Mark parent client as contract type
    await query(
      `UPDATE clients SET client_type = 'contract' WHERE id = $1 AND company_id = $2`,
      [parent_client_id, company_id]
    );

    return reply.status(201).send(rows[0]);
  });

  // ── PATCH /api/contracts/:id ──────────────────────────────────
  app.patch('/contracts/:id', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          contract_number:       { type: 'string' },
          total_mt:              { type: 'number' },
          price_per_mt:          { type: 'number' },
          currency:              { type: 'string' },
          start_date:            { type: 'string' },
          end_date:              { type: 'string' },
          payment_terms:         { type: 'string' },
          payment_schedule_dates:{ type: 'array', items: { type: 'integer' } },
          payment_currency:      { type: 'string' },
          status:                { type: 'string' },
          notes:                 { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const {
      contract_number, total_mt, price_per_mt, currency,
      start_date, end_date, payment_terms, payment_schedule_dates,
      payment_currency, status, notes,
    } = request.body;

    const { rows } = await query(
      `UPDATE contracts
       SET contract_number        = COALESCE($3, contract_number),
           total_mt               = COALESCE($4, total_mt),
           price_per_mt           = COALESCE($5, price_per_mt),
           currency               = COALESCE($6, currency),
           start_date             = COALESCE($7, start_date),
           end_date               = COALESCE($8, end_date),
           payment_terms          = COALESCE($9, payment_terms),
           payment_schedule_dates = COALESCE($10, payment_schedule_dates),
           payment_currency       = COALESCE($11, payment_currency),
           status                 = COALESCE($12, status),
           notes                  = COALESCE($13, notes),
           updated_at             = now()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [id, company_id, contract_number, total_mt, price_per_mt, currency,
       start_date, end_date, payment_terms, payment_schedule_dates ?? null,
       payment_currency, status, notes]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Contract not found' });
    return rows[0];
  });

  // ── GET /api/purchase-orders ──────────────────────────────────
  app.get('/purchase-orders', { preHandler: [app.authenticate] }, async (request, _reply) => {
    const { company_id } = request.user;
    const { contract_id, client_id, status } = request.query;

    const conditions = ['po.company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (contract_id) { conditions.push(`po.contract_id = $${p++}`); params.push(contract_id); }
    if (client_id)   { conditions.push(`po.client_id   = $${p++}`); params.push(client_id); }
    if (status)      { conditions.push(`po.status      = $${p++}`); params.push(status); }

    const { rows } = await query(
      `SELECT po.*,
              cl.name AS client_name, cl.country AS client_country,
              c.contract_number, c.price_per_mt AS contract_price_per_mt
       FROM purchase_orders po
       LEFT JOIN clients cl ON cl.id = po.client_id
       LEFT JOIN contracts c ON c.id = po.contract_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY po.created_at DESC`,
      params
    );
    return { data: rows };
  });

  // ── GET /api/purchase-orders/:id ─────────────────────────────
  app.get('/purchase-orders/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;

    const { rows } = await query(
      `SELECT po.*,
              cl.name AS client_name, cl.country AS client_country,
              c.contract_number, c.price_per_mt AS contract_price_per_mt,
              c.remaining_mt AS contract_remaining_mt,
              c.end_date AS contract_end_date
       FROM purchase_orders po
       LEFT JOIN clients cl ON cl.id = po.client_id
       LEFT JOIN contracts c ON c.id = po.contract_id
       WHERE po.id = $1 AND po.company_id = $2`,
      [id, company_id]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Purchase order not found' });
    return rows[0];
  });

  // ── POST /api/purchase-orders ─────────────────────────────────
  app.post('/purchase-orders', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['po_number', 'client_id', 'quantity_mt'],
        properties: {
          po_number:   { type: 'string' },
          contract_id: { type: 'string' },
          client_id:   { type: 'string' },
          quantity_mt: { type: 'number', exclusiveMinimum: 0 },
          price_per_mt:{ type: 'number' },
          currency:    { type: 'string', default: 'USD' },
          po_date:     { type: 'string' },
          notes:       { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const {
      po_number, contract_id, client_id, quantity_mt,
      price_per_mt, currency = 'USD', po_date, notes,
    } = request.body;

    let resolvedPrice = price_per_mt ?? null;

    // If linked to a contract, deduct from remaining_mt and use contract price
    if (contract_id) {
      const { rows: contractRows } = await query(
        `SELECT remaining_mt, price_per_mt FROM contracts WHERE id = $1 AND company_id = $2`,
        [contract_id, company_id]
      );
      if (contractRows.length === 0) return reply.status(404).send({ error: 'Contract not found' });

      const remaining = parseFloat(contractRows[0].remaining_mt);
      if (quantity_mt > remaining + 0.001) {
        return reply.status(409).send({
          error: `Quantity (${quantity_mt} MT) exceeds contract remaining balance (${remaining} MT)`,
        });
      }

      if (!resolvedPrice) resolvedPrice = contractRows[0].price_per_mt;

      await query(
        `UPDATE contracts SET remaining_mt = remaining_mt - $1, updated_at = now()
         WHERE id = $2 AND company_id = $3`,
        [quantity_mt, contract_id, company_id]
      );
    }

    const total_value = resolvedPrice ? resolvedPrice * quantity_mt : null;

    const { rows } = await query(
      `INSERT INTO purchase_orders
         (company_id, po_number, contract_id, client_id, quantity_mt,
          price_per_mt, total_value, currency, po_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [company_id, po_number, contract_id ?? null, client_id,
       quantity_mt, resolvedPrice, total_value, currency,
       po_date ?? null, notes ?? null]
    );
    return reply.status(201).send(rows[0]);
  });

  // ── PATCH /api/purchase-orders/:id ───────────────────────────
  app.patch('/purchase-orders/:id', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          po_number:   { type: 'string' },
          quantity_mt: { type: 'number' },
          price_per_mt:{ type: 'number' },
          currency:    { type: 'string' },
          po_date:     { type: 'string' },
          status:      { type: 'string' },
          notes:       { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { po_number, quantity_mt, price_per_mt, currency, po_date, status, notes } = request.body;

    const total_value = (price_per_mt && quantity_mt) ? price_per_mt * quantity_mt : null;

    const { rows } = await query(
      `UPDATE purchase_orders
       SET po_number    = COALESCE($3, po_number),
           quantity_mt  = COALESCE($4, quantity_mt),
           price_per_mt = COALESCE($5, price_per_mt),
           total_value  = COALESCE($6, total_value),
           currency     = COALESCE($7, currency),
           po_date      = COALESCE($8, po_date),
           status       = COALESCE($9, status),
           notes        = COALESCE($10, notes),
           updated_at   = now()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [id, company_id, po_number, quantity_mt, price_per_mt, total_value,
       currency, po_date, status, notes]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Purchase order not found' });
    return rows[0];
  });
}
