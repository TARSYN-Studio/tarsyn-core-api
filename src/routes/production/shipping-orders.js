import { query } from '../../db.js';

export default async function shippingOrdersRoutes(app) {

  // GET /api/production/shipping-orders
  app.get('/shipping-orders', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status:               { type: 'string' },
          production_order_id:  { type: 'string' },
          limit:                { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset:               { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { status, production_order_id, limit, offset } = request.query;

    const conditions = ['s.company_id = $1'];
    const params = [company_id];
    let p = 2;
    if (status)              { conditions.push(`s.status = $${p++}`);              params.push(status); }
    if (production_order_id) { conditions.push(`s.production_order_id = $${p++}`); params.push(production_order_id); }
    params.push(limit, offset);

    const { rows } = await query(
      `SELECT s.id, s.production_order_id, s.shipment_number, s.shipment_label,
              s.quantity, s.status, s.transport_status, s.priority,
              s.vessel_name, s.bl_number, s.etd, s.container_loading_date,
              s.port_of_loading, s.port_of_discharge, s.shipping_cost,
              s.created_at, s.updated_at,
              o.po_number, o.material, c.name AS client_name
       FROM production_shipments s
       LEFT JOIN production_orders o ON o.id = s.production_order_id
       LEFT JOIN clients c ON c.id = o.client_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY s.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS total FROM production_shipments s WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2)
    );

    return { data: rows, total: parseInt(countRows[0].total, 10), limit, offset };
  });
}
