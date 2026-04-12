import { query } from '../db.js';

export default async function approvalsRoutes(app) {

  // GET /api/approvals/counts
  // Returns pending counts for all approval-requiring entities
  app.get('/counts', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;

    const [fundRequests, purchases, advances] = await Promise.all([
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
    ]);

    return {
      fund_requests:   parseInt(fundRequests.rows[0].total, 10),
      purchases:       parseInt(purchases.rows[0].total, 10),
      advances:        parseInt(advances.rows[0].total, 10),
      total:           parseInt(fundRequests.rows[0].total, 10) +
                       parseInt(purchases.rows[0].total, 10) +
                       parseInt(advances.rows[0].total, 10),
    };
  });
}
