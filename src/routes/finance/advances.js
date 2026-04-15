import { query, logAudit } from '../../db.js';

export default async function advancesRoutes(app) {

  // ── GET /api/finance/advances ─────────────────────────────────
  app.get('/advances', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status:   { type: 'string' },    // single status filter
          statuses: { type: 'string' },    // comma-separated statuses
          employee_id: { type: 'string' },
        },
      },
    },
  }, async (request, _reply) => {
    const { company_id } = request.user;
    const { status, statuses, employee_id } = request.query;

    const conditions = ['a.company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (statuses) {
      const list = statuses.split(',').map(s => s.trim());
      conditions.push(`a.status = ANY($${p++})`);
      params.push(list);
    } else if (status) {
      conditions.push(`a.status = $${p++}`);
      params.push(status);
    }

    if (employee_id) {
      conditions.push(`a.user_id = $${p++}`);
      params.push(employee_id);
    }

    const { rows } = await query(
      `SELECT
         a.*,
         c.card_name,
         c.last_four AS card_last_four
       FROM employee_cash_advances a
       LEFT JOIN corporate_cards c ON c.id = a.card_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.created_at DESC`,
      params
    );

    return rows.map(r => ({
      ...r,
      corporate_cards: r.card_name ? { card_name: r.card_name, last_four_digits: r.card_last_four } : null,
      card_name: undefined,
      card_last_four: undefined,
    }));
  });

  // ── POST /api/finance/advances ────────────────────────────────
  app.post('/advances', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['employee_name', 'amount', 'purpose'],
        properties: {
          employee_name:  { type: 'string', minLength: 1 },
          amount:         { type: 'number', minimum: 0.01 },
          payment_method: { type: 'string', default: 'cash' },
          card_id:        { type: 'string' },
          purpose:        { type: 'string', minLength: 1 },
          notes:          { type: 'string' },
          currency:       { type: 'string', default: 'SAR' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { employee_name, amount, payment_method, card_id, purpose, notes, currency } = request.body;

    // Generate advance number
    const { rows: last } = await query(
      `SELECT advance_number FROM employee_cash_advances
       WHERE company_id = $1 AND advance_number IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [company_id]
    );
    let advance_number = 'ECA-0001';
    if (last.length && last[0].advance_number) {
      const num = parseInt(last[0].advance_number.split('-')[1] || '0', 10);
      advance_number = `ECA-${String(num + 1).padStart(4, '0')}`;
    }

    const { rows } = await query(
      `INSERT INTO employee_cash_advances
         (company_id, advance_number, employee_name, amount, amount_remaining,
          payment_method, card_id, purpose, notes, currency, status, issued_by, issued_date)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,'issued',$10,CURRENT_DATE)
       RETURNING *`,
      [company_id, advance_number, employee_name, amount,
       payment_method ?? 'cash', card_id ?? null, purpose, notes ?? null,
       currency ?? 'SAR', user_id]
    );

    await logAudit({ companyId: company_id, userId: user_id, action: 'create',
      entityType: 'employee_cash_advance', entityId: rows[0].id, newValues: rows[0] });

    return reply.status(201).send(rows[0]);
  });

  // ── GET /api/finance/advance-submissions ──────────────────────
  app.get('/advance-submissions', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          advance_id: { type: 'string' },
        },
      },
    },
  }, async (request, _reply) => {
    const { company_id } = request.user;
    const { advance_id } = request.query;

    const conditions = ['s.company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (advance_id) {
      conditions.push(`s.advance_id = $${p++}`);
      params.push(advance_id);
    }

    const { rows } = await query(
      `SELECT s.* FROM advance_expense_submissions s
       WHERE ${conditions.join(' AND ')}
       ORDER BY s.created_at DESC`,
      params
    );
    return rows;
  });

  // ── POST /api/finance/advance-submissions ─────────────────────
  app.post('/advance-submissions', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['advance_id', 'expense_date', 'amount', 'description'],
        properties: {
          advance_id:   { type: 'string' },
          expense_date: { type: 'string' },
          amount:       { type: 'number', minimum: 0.01 },
          category:     { type: 'string' },
          description:  { type: 'string', minLength: 1 },
          receipt_url:  { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { advance_id, expense_date, amount, category, description, receipt_url } = request.body;

    // Verify advance belongs to company and has remaining balance
    const { rows: adv } = await query(
      `SELECT * FROM employee_cash_advances WHERE id = $1 AND company_id = $2`,
      [advance_id, company_id]
    );
    if (adv.length === 0) return reply.status(404).send({ error: 'Advance not found' });
    if ((adv[0].amount_remaining ?? 0) < amount) {
      return reply.status(400).send({ error: 'Amount exceeds remaining advance balance' });
    }

    const { rows } = await query(
      `INSERT INTO advance_expense_submissions
         (company_id, advance_id, expense_date, amount, category, description, receipt_url, submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [company_id, advance_id, expense_date, amount, category ?? null, description, receipt_url ?? null, user_id]
    );

    // Update advance balance
    await query(
      `UPDATE employee_cash_advances
       SET amount_expensed = amount_expensed + $1,
           amount_remaining = amount_remaining - $1,
           status = CASE
             WHEN amount_remaining - $1 <= 0 THEN 'fully_expensed'
             ELSE 'partially_expensed'
           END
       WHERE id = $2`,
      [amount, advance_id]
    );

    return reply.status(201).send(rows[0]);
  });

  // ── GET /api/finance/petty-cash ───────────────────────────────
  app.get('/petty-cash', {
    preHandler: [app.authenticate],
  }, async (request, _reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT *, created_at AS last_updated
       FROM fund_accounts
       WHERE company_id = $1 AND account_type = 'petty_cash'
       ORDER BY created_at DESC LIMIT 1`,
      [company_id]
    );
    return rows[0] ?? { current_balance: 0, currency: 'SAR', last_updated: null };
  });

  // ── GET /api/finance/balance-comparison ──────────────────────
  // Compare stored balances vs calculated-from-transactions
  app.get('/balance-comparison', {
    preHandler: [app.authenticate],
  }, async (request, _reply) => {
    const { company_id } = request.user;

    // Fund accounts: stored vs sum of transactions
    const { rows: fundRows } = await query(
      `SELECT
         fa.id AS entity_id,
         fa.account_name AS entity_name,
         fa.account_type AS entity_type,
         fa.current_balance AS stored_balance,
         COALESCE(SUM(
           CASE WHEN ft.transaction_type = 'inflow' THEN ft.amount
                WHEN ft.transaction_type = 'outflow' THEN -ft.amount
                ELSE 0 END
         ), 0) AS calculated_balance
       FROM fund_accounts fa
       LEFT JOIN fund_transactions ft ON ft.account_id = fa.id AND ft.company_id = fa.company_id
       WHERE fa.company_id = $1
       GROUP BY fa.id, fa.account_name, fa.account_type, fa.current_balance`,
      [company_id]
    );

    return fundRows.map(r => ({
      ...r,
      stored_balance: parseFloat(r.stored_balance) || 0,
      calculated_balance: parseFloat(r.calculated_balance) || 0,
      discrepancy: (parseFloat(r.stored_balance) || 0) - (parseFloat(r.calculated_balance) || 0),
      status: Math.abs((parseFloat(r.stored_balance) || 0) - (parseFloat(r.calculated_balance) || 0)) < 0.01 ? 'OK' : 'MISMATCH',
    }));
  });

  // ── POST /api/finance/recalculate-balances ────────────────────
  app.post('/recalculate-balances', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;

    // Recalculate fund_accounts balances from transactions
    const { rows: adjustments } = await query(
      `WITH calculated AS (
         SELECT
           fa.id,
           fa.account_name,
           fa.current_balance AS stored_balance,
           COALESCE(SUM(
             CASE WHEN ft.transaction_type = 'inflow' THEN ft.amount
                  WHEN ft.transaction_type = 'outflow' THEN -ft.amount
                  ELSE 0 END
           ), 0) AS calculated_balance
         FROM fund_accounts fa
         LEFT JOIN fund_transactions ft ON ft.account_id = fa.id AND ft.company_id = fa.company_id
         WHERE fa.company_id = $1
         GROUP BY fa.id, fa.account_name, fa.current_balance
         HAVING ABS(fa.current_balance - COALESCE(SUM(
           CASE WHEN ft.transaction_type = 'inflow' THEN ft.amount
                WHEN ft.transaction_type = 'outflow' THEN -ft.amount
                ELSE 0 END
         ), 0)) > 0.01
       )
       UPDATE fund_accounts fa
       SET current_balance = c.calculated_balance
       FROM calculated c
       WHERE fa.id = c.id
       RETURNING fa.id, fa.account_name, c.stored_balance, c.calculated_balance,
                 (c.calculated_balance - c.stored_balance) AS discrepancy`,
      [company_id]
    );

    // Log reconciliation
    if (adjustments.length > 0) {
      await query(
        `INSERT INTO balance_reconciliations (company_id, reconciled_by, discrepancies)
         VALUES ($1, $2, $3)`,
        [company_id, user_id, JSON.stringify(adjustments)]
      );
    }

    return adjustments;
  });

  // ── GET /api/finance/reconciliations ─────────────────────────
  app.get('/reconciliations', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', default: 10 } },
      },
    },
  }, async (request, _reply) => {
    const { company_id } = request.user;
    const { limit } = request.query;

    const { rows } = await query(
      `SELECT *, reconciled_at AS created_at FROM balance_reconciliations
       WHERE company_id = $1
       ORDER BY reconciled_at DESC
       LIMIT $2`,
      [company_id, limit ?? 10]
    );
    return rows;
  });

  // ── GET /api/finance/daily-pnl ────────────────────────────────
  app.get('/daily-pnl', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        required: ['start', 'end'],
        properties: {
          start: { type: 'string' },
          end:   { type: 'string' },
        },
      },
    },
  }, async (request, _reply) => {
    const { company_id } = request.user;
    const { start, end } = request.query;
    const monthStr = start.substring(0, 7); // 'yyyy-MM'

    const monthEnd = new Date(parseInt(monthStr.split('-')[0]), parseInt(monthStr.split('-')[1]), 0).toISOString().split('T')[0];
    const [ccRows, pcRows, batchRows, orderRows, purchaseRows] = await Promise.all([
      // Cost components
      query(`SELECT name, category, calculation_type, value, is_deduction
             FROM cost_components WHERE company_id = $1 AND is_active = true`, [company_id]),
      // Plant costs
      query(`SELECT payroll_cost_per_mt, management_cost_per_mt
             FROM plant_costs WHERE company_id = $1
               AND month_year >= $2 AND month_year <= $3 LIMIT 1`,
        [company_id, `${monthStr}-01`, monthEnd]),
      // Stage 2 production in range
      query(`SELECT production_date, quantity FROM production_batches
             WHERE company_id = $1 AND stage = 'stage2'
               AND production_date >= $2 AND production_date <= $3`,
        [company_id, start, end]),
      // Orders with pricing
      query(`SELECT price_per_mt_usd, usd_to_sar_rate FROM production_orders
             WHERE company_id = $1 AND price_per_mt_usd IS NOT NULL LIMIT 100`, [company_id]),
      // Recent raw material purchases
      query(`SELECT tonnage, purchase_amount, transport_cost FROM raw_material_purchases
             WHERE company_id = $1 ORDER BY created_at DESC LIMIT 10`, [company_id]),
    ]);

    const components = ccRows.rows;
    const plant = pcRows.rows[0] || {};
    const batches = batchRows.rows;
    const orders = orderRows.rows;
    const purchases = purchaseRows.rows;

    // Monthly fixed costs
    const totalMonthlyFixed = components
      .filter(c => c.calculation_type === 'MONTHLY_FIXED' && !c.is_deduction)
      .reduce((s, c) => s + parseFloat(c.value || 0), 0);

    // Monthly production
    const { rows: monthlyBatches } = await query(
      `SELECT quantity FROM production_batches WHERE company_id = $1 AND stage = 'stage2'
       AND production_date >= $2 AND production_date <= $3`,
      [company_id, `${monthStr}-01`, monthEnd]
    );
    const totalMonthlyMT = monthlyBatches.reduce((s, b) => s + parseFloat(b.quantity || 0), 0) || 1;

    const fixedPerMT = totalMonthlyFixed / totalMonthlyMT;
    const variablePerMT = components.reduce((s, c) => {
      if (c.calculation_type !== 'PER_MT') return s;
      return c.is_deduction ? s - parseFloat(c.value || 0) : s + parseFloat(c.value || 0);
    }, 0);
    const fobPerMT = components
      .filter(c => c.calculation_type === 'PER_CONTAINER')
      .reduce((s, c) => s + (parseFloat(c.value || 0) * 3.75 / 20), 0);
    const plantPerMT = (parseFloat(plant.payroll_cost_per_mt || 0)) + (parseFloat(plant.management_cost_per_mt || 0));

    const avgPrice = orders.length
      ? orders.reduce((s, o) => s + (parseFloat(o.price_per_mt_usd || 0) * parseFloat(o.usd_to_sar_rate || 3.75)), 0) / orders.length
      : 3937.5;

    const totalMaterialCost = purchases.reduce((s, p) => s + parseFloat(p.purchase_amount || 0) + parseFloat(p.transport_cost || 0), 0);
    const totalMaterialQty = purchases.reduce((s, p) => s + parseFloat(p.tonnage || 0), 0);
    const rawMatPerMT = totalMaterialQty > 0 ? totalMaterialCost / totalMaterialQty : 2000;
    const totalCOGSPerMT = rawMatPerMT + variablePerMT + fixedPerMT + fobPerMT + plantPerMT;

    // Group batches by day
    const batchByDay = batches.reduce((acc, b) => {
      const d = b.production_date.toISOString ? b.production_date.toISOString().split('T')[0] : String(b.production_date).split('T')[0];
      acc[d] = (acc[d] || 0) + parseFloat(b.quantity || 0);
      return acc;
    }, {});

    // Generate daily range
    const results = [];
    const from = new Date(start);
    const to = new Date(end);
    const workingDays = [];
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 5) workingDays.push(new Date(d));
    }
    const dailyFixed = workingDays.length > 0 ? totalMonthlyFixed / workingDays.length : 0;

    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      const isFri = d.getDay() === 5;
      const prodMT = batchByDay[dateStr] || 0;
      const revenue = prodMT * avgPrice;
      const cogs = prodMT * totalCOGSPerMT;
      const dailyFC = isFri ? 0 : dailyFixed;
      const grossProfit = revenue - cogs;
      const netProfit = grossProfit - dailyFC;
      results.push({ date: dateStr, production_mt: prodMT, revenue, cogs, daily_fixed_cost: dailyFC, gross_profit: grossProfit, net_profit: netProfit, is_friday: isFri });
    }

    return results;
  });
}
