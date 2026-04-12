import { query } from '../../db.js';

export default async function shipmentsRoutes(app) {

  // ── GET /api/production/shipments ─────────────────────────────
  app.get('/shipments', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          order_id: { type: 'string' },
          status:   { type: 'string' },
          limit:    { type: 'integer', minimum: 1, maximum: 200, default: 100 },
          offset:   { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { order_id, status, limit, offset } = request.query;

    const conditions = ['s.company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (order_id) {
      conditions.push(`s.production_order_id = $${p++}`);
      params.push(order_id);
    }
    if (status) {
      conditions.push(`s.status = $${p++}`);
      params.push(status);
    }

    params.push(limit, offset);

    const { rows } = await query(
      `SELECT s.*,
              o.po_number, o.client_name, o.material, o.vessel_name,
              o.bl_number, o.etd, o.quantity AS order_quantity,
              o.status AS order_status, o.transport_status, o.is_partial_shipment
       FROM production_shipments s
       LEFT JOIN production_orders o ON o.id = s.production_order_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY s.priority ASC, s.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS total FROM production_shipments s
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

  // ── POST /api/production/shipments ────────────────────────────
  app.post('/shipments', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['production_order_id'],
        properties: {
          production_order_id: { type: 'string' },
          shipment_number:     { type: 'integer', minimum: 1, default: 1 },
          shipment_label:      { type: 'string' },
          quantity:            { type: 'number', minimum: 0 },
          status:              { type: 'string', default: 'pending' },
          priority:            { type: 'integer', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: created_by } = request.user;
    const {
      production_order_id, shipment_number = 1, shipment_label,
      quantity, status = 'pending', priority = 0,
    } = request.body;

    // Verify the order belongs to this company
    const { rows: orderRows } = await query(
      `SELECT id FROM production_orders WHERE id = $1 AND company_id = $2`,
      [production_order_id, company_id]
    );
    if (orderRows.length === 0) {
      return reply.status(404).send({ error: 'Production order not found' });
    }

    const { rows } = await query(
      `INSERT INTO production_shipments
         (company_id, production_order_id, shipment_number, shipment_label,
          quantity, status, priority, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        company_id, production_order_id, shipment_number,
        shipment_label ?? null, quantity ?? null, status, priority, created_by,
      ]
    );

    return reply.status(201).send(rows[0]);
  });

  // ── PATCH /api/production/shipments/:id ───────────────────────
  app.patch('/shipments/:id', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          status:          { type: 'string' },
          quantity:        { type: 'number', minimum: 0 },
          shipment_label:  { type: 'string' },
          priority:        { type: 'integer' },
          shipment_number: { type: 'integer', minimum: 1 },
          vessel_name:      { type: 'string' },
          bl_number:        { type: 'string' },
          etd:              { type: 'string' },
          container_loading_date: { type: 'string' },
          port_of_loading:  { type: 'string' },
          port_of_discharge: { type: 'string' },
          shipping_company_id: { type: 'string' },
          shipping_cost:    { type: 'number' },
          transport_status: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const {
      status, quantity, shipment_label, priority, shipment_number,
      vessel_name, bl_number, etd, container_loading_date,
      port_of_loading, port_of_discharge, shipping_company_id, shipping_cost, transport_status,
    } = request.body;

    const { rows: existing } = await query(
      `SELECT id FROM production_shipments WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) {
      return reply.status(404).send({ error: 'Shipment not found' });
    }

    const sets = ['updated_at = now()'];
    const params = [id, company_id];
    let p = 3;

    if (status          !== undefined) { sets.push(`status = $${p++}`);          params.push(status); }
    if (quantity        !== undefined) { sets.push(`quantity = $${p++}`);        params.push(quantity); }
    if (shipment_label  !== undefined) { sets.push(`shipment_label = $${p++}`);  params.push(shipment_label); }
    if (priority        !== undefined) { sets.push(`priority = $${p++}`);        params.push(priority); }
    if (shipment_number !== undefined) { sets.push(`shipment_number = $${p++}`); params.push(shipment_number); }

    const { rows } = await query(
      `UPDATE production_shipments
       SET ${sets.join(', ')}
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      params
    );

    return rows[0];
  });
}
