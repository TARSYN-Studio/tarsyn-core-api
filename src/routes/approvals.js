import { query } from '../db.js';

export default async function approvalsRoutes(app) {

  // GET /api/approvals/counts
  app.get('/counts', { preHandler: [app.authenticate] }, async (request) => {
    const { company_id } = request.user;

    const [fundRequests, purchases, advances, byproductSales, supplierRequests] = await Promise.all([
      query(
        `SELECT COUNT(*) AS total FROM fund_requests
         WHERE company_id = $1 AND status IN ('submitted','manager_approved') AND deleted_at IS NULL`,
        [company_id]
      ),
      query(
        `SELECT COUNT(*) AS total FROM raw_material_purchases
         WHERE company_id = $1 AND status = 'pending'`,
        [company_id]
      ),
      query(
        `SELECT COUNT(*) AS total FROM employee_cash_advances
         WHERE company_id = $1 AND status = 'pending'`,
        [company_id]
      ),
      query(
        `SELECT COUNT(*) AS total FROM byproduct_sales
         WHERE company_id = $1 AND status = 'pending_approval'`,
        [company_id]
      ),
      query(
        `SELECT COUNT(*) AS total FROM supplier_requests
         WHERE company_id = $1 AND status = 'pending'`,
        [company_id]
      ),
    ]);

    const fundRequestsTotal  = parseInt(fundRequests.rows[0].total, 10);
    const purchasesTotal     = parseInt(purchases.rows[0].total, 10);
    const advancesTotal      = parseInt(advances.rows[0].total, 10);
    const byproductSalesTotal = parseInt(byproductSales.rows[0].total, 10);

    const supplierRequestsTotal = parseInt(supplierRequests.rows[0].total, 10);
    return {
      fund_requests:     fundRequestsTotal,
      purchases:         purchasesTotal,
      advances:          advancesTotal,
      byproduct_sales:   byproductSalesTotal,
      supplier_requests: supplierRequestsTotal,
      total: fundRequestsTotal + purchasesTotal + advancesTotal + byproductSalesTotal + supplierRequestsTotal,
    };
  });

  // GET /api/approvals/byproduct-sales — list pending byproduct sales for CEO approval
  app.get('/byproduct-sales', { preHandler: [app.authenticate] }, async (request) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT s.id, s.item_type, s.quantity_mt, s.price_per_mt, s.total_amount,
              s.sale_date, s.status, s.notes, s.created_at,
              b.name AS buyer_name,
              u.full_name AS created_by_name
       FROM byproduct_sales s
       LEFT JOIN byproduct_buyers b ON b.id = s.buyer_id
       LEFT JOIN users u ON u.id = s.created_by
       WHERE s.company_id = $1 AND s.status = 'pending_approval'
       ORDER BY s.created_at ASC`,
      [company_id]
    );
    return { data: rows };
  });
}
