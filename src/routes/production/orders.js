import { query } from '../../db.js';

export default async function ordersRoutes(app) {

  // ── GET /api/production/orders ────────────────────────────────
  app.get('/orders', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status:    { type: 'string' },
          client_id: { type: 'string' },
          limit:     { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset:    { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { status, client_id, limit, offset } = request.query;

    const conditions = ['o.company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (status) {
      conditions.push(`o.status = $${p++}`);
      params.push(status);
    }
    if (client_id) {
      conditions.push(`o.client_id = $${p++}`);
      params.push(client_id);
    }

    params.push(limit, offset);

    const { rows } = await query(
      `SELECT o.id, o.po_number, o.material, o.quantity, o.unit,
              o.price_per_mt_usd, o.usd_to_sar_rate, o.status, o.notes,
              o.created_at, o.created_by,
              c.name AS client_name
       FROM production_orders o
       LEFT JOIN clients c ON c.id = o.client_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY o.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    // params ends with [limit, offset] — slice those off for the count query
    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS total FROM production_orders o
       WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2)
    );

    return {
      data:   rows,
      total:  parseInt(countRows[0].total, 10),
      limit,
      offset,
    };
  });

  // ── POST /api/production/orders ───────────────────────────────
  app.post('/orders', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['po_number'],
        properties: {
          po_number:        { type: 'string', minLength: 1 },
          client_id:        { type: 'string' },
          material:         { type: 'string' },
          quantity:         { type: 'number', minimum: 0 },
          unit:             { type: 'string', default: 'MT' },
          price_per_mt_usd: { type: 'number', minimum: 0 },
          usd_to_sar_rate:  { type: 'number', minimum: 0, default: 3.75 },
          notes:            { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: created_by } = request.user;
    const {
      po_number, client_id, material, quantity,
      unit = 'MT', price_per_mt_usd, usd_to_sar_rate = 3.75, notes,
    } = request.body;

    // Duplicate PO number check
    const { rows: existing } = await query(
      `SELECT id FROM production_orders WHERE company_id = $1 AND po_number = $2`,
      [company_id, po_number.trim()]
    );
    if (existing.length > 0) {
      return reply.status(409).send({ error: `PO number '${po_number}' already exists` });
    }

    const { rows } = await query(
      `INSERT INTO production_orders
         (company_id, po_number, client_id, material, quantity, unit,
          price_per_mt_usd, usd_to_sar_rate, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        company_id, po_number.trim(), client_id ?? null, material ?? null,
        quantity ?? null, unit, price_per_mt_usd ?? null,
        usd_to_sar_rate, notes ?? null, created_by,
      ]
    );

    return reply.status(201).send(rows[0]);
  });

  // ── GET /api/production/orders/:id ───────────────────────────
  app.get('/orders/:id', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;

    const { rows } = await query(
      `SELECT o.*, c.name AS client_name
       FROM production_orders o
       LEFT JOIN clients c ON c.id = o.client_id
       WHERE o.id = $1 AND o.company_id = $2`,
      [id, company_id]
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Production order not found' });
    }

    return rows[0];
  });
}
