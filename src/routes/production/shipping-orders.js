import { query } from '../../db.js';

export default async function shippingOrdersRoutes(app) {

  // GET /api/production/shipping-orders
  app.get('/shipping-orders', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          view:   { type: 'string', enum: ['active', 'history'], default: 'active' },
          limit:  { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { view, limit, offset } = request.query;

    // Active: ready_to_dispatch or dispatched orders (from production_orders)
    // History: shipped/completed
    const orderStatuses = view === 'history'
      ? "('shipped', 'completed')"
      : "('ready_to_dispatch', 'dispatched')";

    // Query production_orders directly — this is the source of truth for order status
    const { rows } = await query(
      `SELECT o.id, o.po_number, o.material, o.quantity, o.status, o.transport_status,
              o.vessel_name, o.bl_number, o.etd, o.container_loading_date,
              o.port_of_loading, o.port_of_discharge, o.notes,
              o.is_partial_shipment, o.priority, o.created_at, o.updated_at,
              c.name AS client_name
       FROM production_orders o
       LEFT JOIN clients c ON c.id = o.client_id
       WHERE o.company_id = $1 AND o.status IN ${orderStatuses}
       ORDER BY o.created_at DESC
       LIMIT $2 OFFSET $3`,
      [company_id, limit, offset]
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS total FROM production_orders
       WHERE company_id = $1 AND status IN ${orderStatuses}`,
      [company_id]
    );

    const data = rows.map(row => ({
      id: row.id,
      poNumber: row.po_number,
      clientName: row.client_name || 'Unknown',
      tonnage: parseFloat(row.quantity) || 0,
      shippingDate: row.container_loading_date || row.etd || row.created_at,
      pol: row.port_of_loading || '',
      status: row.status === 'ready_to_dispatch' ? 'ready' : 'dispatched',
      vesselName: row.vessel_name || null,
      blNumber: row.bl_number || null,
      etd: row.etd || null,
      shipmentId: null,
      shipmentNumber: null,
      isPartialShipment: Boolean(row.is_partial_shipment),
      material: row.material,
      transportStatus: row.transport_status,
      notes: row.notes,
    }));

    return { data, total: parseInt(countRows[0].total, 10), limit, offset };
  });
}

