import { query, withTransaction } from '../../db.js';

export default async function dispatchRoutes(app) {

  // POST /api/production/orders/:id/dispatch
  app.post('/orders/:id/dispatch', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: created_by } = request.user;
    const { id } = request.params;
    const {
      shipment_number, quantity, vessel_name, bl_number, etd,
      container_loading_date, port_of_loading, port_of_discharge,
      shipping_cost, shipment_label,
    } = request.body ?? {};

    const result = await withTransaction(async (client) => {
      const { rows: order } = await client.query(
        `SELECT id, po_number, quantity, status FROM production_orders
         WHERE id = $1 AND company_id = $2`,
        [id, company_id]
      );
      if (!order.length) throw Object.assign(new Error('Order not found'), { statusCode: 404 });

      const { rows: shipment } = await client.query(
        `INSERT INTO production_shipments
           (company_id, production_order_id, shipment_number, shipment_label, quantity,
            status, vessel_name, bl_number, etd, container_loading_date,
            port_of_loading, port_of_discharge, shipping_cost, created_by)
         VALUES ($1,$2,$3,$4,$5,'in_progress',$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          company_id, id,
          shipment_number ?? 1, shipment_label ?? null,
          quantity ?? order[0].quantity,
          vessel_name ?? null, bl_number ?? null, etd ?? null,
          container_loading_date ?? null, port_of_loading ?? null,
          port_of_discharge ?? null, shipping_cost ?? null,
          created_by,
        ]
      );

      // Update order transport_status
      await client.query(
        `UPDATE production_orders SET transport_status = 'in_progress', updated_at = now()
         WHERE id = $1 AND company_id = $2`,
        [id, company_id]
      );

      return shipment[0];
    });

    return reply.status(201).send(result);
  });

  // GET /api/production/orders/by-po/:po_number
  app.get('/orders/by-po/:po_number', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { po_number } = request.params;

    const { rows } = await query(
      `SELECT o.*, c.name AS client_name
       FROM production_orders o
       LEFT JOIN clients c ON c.id = o.client_id
       WHERE o.company_id = $1 AND o.po_number = $2`,
      [company_id, po_number]
    );

    if (!rows.length) return reply.status(404).send({ error: 'Order not found' });
    return rows[0];
  });
}
