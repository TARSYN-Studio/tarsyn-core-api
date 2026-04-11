import { query } from '../../db.js';

export default async function fulfillmentRoutes(app) {

  // ── GET /api/production/fulfillment ───────────────────────────
  // Returns po_fulfillment_transactions joined with production_orders
  // to compute client_name, total_required, and remaining_quantity.
  app.get('/fulfillment', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          po_number:  { type: 'string' },
          order_id:   { type: 'string' },
          limit:      { type: 'integer', minimum: 1, maximum: 200, default: 25 },
          offset:     { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { po_number, order_id, limit, offset } = request.query;

    const conditions = ['t.company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (po_number) {
      conditions.push(`t.po_number = $${p++}`);
      params.push(po_number);
    }
    if (order_id) {
      conditions.push(`t.production_order_id = $${p++}`);
      params.push(order_id);
    }

    params.push(limit, offset);

    // Compute remaining_quantity and total_required via window function
    const { rows } = await query(
      `SELECT
         t.id,
         t.company_id,
         t.production_order_id,
         t.po_number,
         t.allocated_quantity,
         t.transaction_type,
         t.notes,
         t.created_at AS transaction_date,
         t.created_by,
         o.client_name,
         o.quantity AS total_required,
         GREATEST(
           o.quantity - SUM(t2.allocated_quantity) OVER (
             PARTITION BY t.production_order_id
             ORDER BY t.created_at
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ),
           0
         ) AS remaining_quantity
       FROM po_fulfillment_transactions t
       LEFT JOIN production_orders o ON o.id = t.production_order_id
       LEFT JOIN po_fulfillment_transactions t2
         ON t2.production_order_id = t.production_order_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY t.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS total FROM po_fulfillment_transactions t
       WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2)
    );

    return {
      data:  rows,
      total: parseInt(countRows[0].total, 10),
      limit,
      offset,
    };
  });

  // ── POST /api/production/fulfillment ──────────────────────────
  app.post('/fulfillment', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['po_number', 'allocated_quantity'],
        properties: {
          production_order_id: { type: 'string' },
          po_number:           { type: 'string', minLength: 1 },
          allocated_quantity:  { type: 'number', minimum: 0.0001 },
          transaction_type:    { type: 'string', default: 'allocation' },
          notes:               { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: created_by } = request.user;
    const {
      production_order_id, po_number, allocated_quantity,
      transaction_type = 'allocation', notes,
    } = request.body;

    // Resolve production_order_id from po_number if not provided
    let resolvedOrderId = production_order_id ?? null;
    if (!resolvedOrderId) {
      const { rows: orderRows } = await query(
        `SELECT id FROM production_orders WHERE company_id = $1 AND po_number = $2 LIMIT 1`,
        [company_id, po_number]
      );
      if (orderRows.length > 0) resolvedOrderId = orderRows[0].id;
    }

    const { rows } = await query(
      `INSERT INTO po_fulfillment_transactions
         (company_id, production_order_id, po_number, allocated_quantity,
          transaction_type, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        company_id, resolvedOrderId, po_number,
        allocated_quantity, transaction_type, notes ?? null, created_by,
      ]
    );

    return reply.status(201).send(rows[0]);
  });
}
