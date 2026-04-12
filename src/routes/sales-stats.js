import { query } from '../db.js';

export default async function salesRoutes(app) {

  // GET /api/sales/stats
  app.get('/stats', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;

    const [orders, clients, revenue] = await Promise.all([
      query(
        `SELECT
           COUNT(*) FILTER (WHERE status NOT IN ('cancelled')) AS total_orders,
           COUNT(*) FILTER (WHERE status = 'shipped') AS completed_orders,
           COUNT(*) FILTER (WHERE status IN ('pending_review','approved','in_production')) AS active_orders,
           COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_orders,
           SUM(quantity) FILTER (WHERE status NOT IN ('cancelled')) AS total_quantity_mt
         FROM production_orders
         WHERE company_id = $1`,
        [company_id]
      ),
      query(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_active) AS active
         FROM clients WHERE company_id = $1`,
        [company_id]
      ),
      query(
        `SELECT
           COALESCE(SUM(price_per_mt_usd * quantity), 0) AS total_revenue_usd,
           COALESCE(SUM(price_per_mt_usd * quantity * usd_to_sar_rate), 0) AS total_revenue_sar,
           COALESCE(SUM(price_per_mt_usd * quantity) FILTER (WHERE payment_received), 0) AS collected_usd
         FROM production_orders
         WHERE company_id = $1 AND status NOT IN ('cancelled')`,
        [company_id]
      ),
    ]);

    return {
      orders: orders.rows[0],
      clients: clients.rows[0],
      revenue: revenue.rows[0],
    };
  });
}
