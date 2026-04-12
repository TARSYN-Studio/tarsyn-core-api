import { query } from '../db.js';

export default async function ceoKpiRoutes(app) {

  // ── GET /api/dashboard/kpi ────────────────────────────────────
  app.get('/kpi', { preHandler: [app.authenticate] }, async (request, _reply) => {
    const { company_id } = request.user;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
    const today = now.toISOString().split('T')[0];

    const [
      contracts,
      salesThisMonth,
      shipmentsInTransit,
      overduePayments,
      wallets,
      pendingApprovals,
      employees,
      productionOrders,
    ] = await Promise.all([
      // Active contracts + remaining MT
      query(`SELECT COUNT(*) AS total_contracts,
                    COALESCE(SUM(remaining_mt), 0) AS total_remaining_mt
             FROM contracts WHERE company_id=$1 AND status='active'`, [company_id]),

      // Sales this month (sum of paid + unpaid sales orders)
      query(`SELECT COALESCE(SUM(total_value), 0) AS total_usd,
                    COUNT(*) AS order_count
             FROM sales_orders
             WHERE company_id=$1 AND created_at >= $2 AND created_at <= $3`, [company_id, monthStart, monthEnd]),

      // Shipments in transit
      query(`SELECT COUNT(*) AS cnt
             FROM sales_orders
             WHERE company_id=$1 AND status NOT IN ('delivered','cancelled') AND bl_number IS NOT NULL`, [company_id]),

      // Overdue payments
      query(`SELECT COUNT(*) AS cnt, COALESCE(SUM(total_value), 0) AS amount
             FROM sales_orders
             WHERE company_id=$1 AND payment_due_date < $2 AND payment_status != 'paid'`, [company_id, today]),

      // Wallet balances
      query(`SELECT account_type, current_balance FROM fund_accounts WHERE company_id=$1`, [company_id]),

      // Pending approvals (fund requests)
      query(`SELECT COUNT(*) AS cnt FROM fund_requests WHERE company_id=$1 AND status='pending'`, [company_id]),

      // Active employees
      query(`SELECT COUNT(*) FILTER (WHERE status='active') AS active_employees,
                    COUNT(*) AS total_employees
             FROM employees WHERE company_id=$1`, [company_id]),

      // Production orders in progress
      query(`SELECT COUNT(*) AS cnt FROM production_orders WHERE company_id=$1 AND status NOT IN ('completed','voided')`, [company_id]),
    ]);

    const walletMap = { petty_cash: 0, raw_materials: 0 };
    for (const w of wallets.rows) {
      walletMap[w.account_type] = parseFloat(w.current_balance || 0);
    }

    return {
      contracts: {
        active: parseInt(contracts.rows[0]?.total_contracts || 0),
        remaining_mt: parseFloat(contracts.rows[0]?.total_remaining_mt || 0),
      },
      sales_this_month: {
        total_usd: parseFloat(salesThisMonth.rows[0]?.total_usd || 0),
        order_count: parseInt(salesThisMonth.rows[0]?.order_count || 0),
      },
      shipments_in_transit: parseInt(shipmentsInTransit.rows[0]?.cnt || 0),
      overdue_payments: {
        count: parseInt(overduePayments.rows[0]?.cnt || 0),
        amount: parseFloat(overduePayments.rows[0]?.amount || 0),
      },
      wallets: walletMap,
      pending_approvals: parseInt(pendingApprovals.rows[0]?.cnt || 0),
      employees: {
        active: parseInt(employees.rows[0]?.active_employees || 0),
        total: parseInt(employees.rows[0]?.total_employees || 0),
      },
      production_in_progress: parseInt(productionOrders.rows[0]?.cnt || 0),
      generated_at: new Date().toISOString(),
    };
  });
}
