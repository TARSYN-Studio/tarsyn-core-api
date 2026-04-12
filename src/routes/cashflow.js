'use strict';

export default async function cashflowRoutes(fastify) {
  const db = fastify.db;

  // ─── EXPENSE PROJECTIONS ────────────────────────────────────────────────────

  fastify.get('/expense-projections', async (req, reply) => {
    const companyId = req.user.company_id;
    const { is_active } = req.query;
    let q = 'SELECT * FROM expense_projections WHERE company_id = $1';
    const params = [companyId];
    if (is_active !== undefined) {
      params.push(is_active === 'true');
      q += ` AND is_active = $${params.length}`;
    }
    q += ' ORDER BY category, item';
    const { rows } = await db.query(q, params);
    return rows;
  });

  fastify.post('/expense-projections', async (req, reply) => {
    const companyId = req.user.company_id;
    const { category, item, amount, frequency, payment_day, start_date, end_date, notes } = req.body;
    const { rows } = await db.query(
      `INSERT INTO expense_projections (company_id, category, item, amount, frequency, payment_day, start_date, end_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [companyId, category, item, amount, frequency || 'Monthly', payment_day || null, start_date, end_date || null, notes || null]
    );
    return rows[0];
  });

  fastify.patch('/expense-projections/:id', async (req, reply) => {
    const companyId = req.user.company_id;
    const { id } = req.params;
    const fields = req.body;
    const allowed = ['category','item','amount','frequency','payment_day','start_date','end_date','is_active','notes'];
    const sets = []; const vals = [companyId, id];
    for (const k of allowed) {
      if (k in fields) { sets.push(`${k} = $${vals.push(fields[k])}`); }
    }
    if (!sets.length) return reply.code(400).send({ error: 'No fields' });
    const { rows } = await db.query(
      `UPDATE expense_projections SET ${sets.join(',')} WHERE company_id=$1 AND id=$2 RETURNING *`,
      vals
    );
    return rows[0];
  });

  fastify.delete('/expense-projections/:id', async (req, reply) => {
    const companyId = req.user.company_id;
    await db.query('DELETE FROM expense_projections WHERE company_id=$1 AND id=$2', [companyId, req.params.id]);
    return { success: true };
  });

  // ─── FORECASTED CLIENT SALES ────────────────────────────────────────────────

  fastify.get('/forecasted-client-sales', async (req, reply) => {
    const companyId = req.user.company_id;
    const { status, statuses, gte_month, lte_month, baseline_profile_id } = req.query;
    let q = 'SELECT * FROM forecasted_client_sales WHERE company_id = $1';
    const params = [companyId];
    if (status) { params.push(status); q += ` AND status = $${params.length}`; }
    if (statuses) {
      const arr = statuses.split(',');
      params.push(arr); q += ` AND status = ANY($${params.length})`;
    }
    if (gte_month) { params.push(gte_month); q += ` AND forecast_month >= $${params.length}`; }
    if (lte_month) { params.push(lte_month); q += ` AND forecast_month <= $${params.length}`; }
    if (baseline_profile_id) { params.push(baseline_profile_id); q += ` AND baseline_profile_id = $${params.length}`; }
    q += ' ORDER BY forecast_month, client_name';
    const { rows } = await db.query(q, params);
    return rows;
  });

  fastify.post('/forecasted-client-sales', async (req, reply) => {
    const companyId = req.user.company_id;
    const body = req.body;
    // Support array
    if (Array.isArray(body)) {
      const results = [];
      for (const item of body) {
        const { rows } = await db.query(
          `INSERT INTO forecasted_client_sales
            (company_id, client_id, client_name, forecast_month, forecasted_amount, forecasted_po_number, quantity, price_per_unit, status, po_number, notes, baseline_profile_id, remaining_quantity_mt, expected_payment_date, expected_production_complete_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [companyId, item.client_id||null, item.client_name, item.forecast_month, item.forecasted_amount||0, item.forecasted_po_number||null, item.quantity||0, item.price_per_unit||0, item.status||'forecasted', item.po_number||null, item.notes||null, item.baseline_profile_id||null, item.remaining_quantity_mt||null, item.expected_payment_date||null, item.expected_production_complete_date||null]
        );
        results.push(rows[0]);
      }
      return results;
    }
    const { rows } = await db.query(
      `INSERT INTO forecasted_client_sales
        (company_id, client_id, client_name, forecast_month, forecasted_amount, forecasted_po_number, quantity, price_per_unit, status, po_number, notes, baseline_profile_id, remaining_quantity_mt, expected_payment_date, expected_production_complete_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [companyId, body.client_id||null, body.client_name, body.forecast_month, body.forecasted_amount||0, body.forecasted_po_number||null, body.quantity||0, body.price_per_unit||0, body.status||'forecasted', body.po_number||null, body.notes||null, body.baseline_profile_id||null, body.remaining_quantity_mt||null, body.expected_payment_date||null, body.expected_production_complete_date||null]
    );
    return rows[0];
  });

  fastify.patch('/forecasted-client-sales/:id', async (req, reply) => {
    const companyId = req.user.company_id;
    const { id } = req.params;
    const fields = req.body;
    const allowed = ['client_id','client_name','forecast_month','forecasted_amount','forecasted_po_number','quantity','price_per_unit','status','po_number','notes','baseline_profile_id','remaining_quantity_mt','expected_payment_date','expected_production_complete_date'];
    const sets = []; const vals = [companyId, id];
    for (const k of allowed) {
      if (k in fields) { sets.push(`${k} = $${vals.push(fields[k])}`); }
    }
    if (!sets.length) return reply.code(400).send({ error: 'No fields' });
    const { rows } = await db.query(
      `UPDATE forecasted_client_sales SET ${sets.join(',')} WHERE company_id=$1 AND id=$2 RETURNING *`,
      vals
    );
    return rows[0];
  });

  fastify.delete('/forecasted-client-sales/:id', async (req, reply) => {
    const companyId = req.user.company_id;
    await db.query('DELETE FROM forecasted_client_sales WHERE company_id=$1 AND id=$2', [companyId, req.params.id]);
    return { success: true };
  });

  fastify.delete('/forecasted-client-sales/by-profile/:profileId', async (req, reply) => {
    const companyId = req.user.company_id;
    await db.query('DELETE FROM forecasted_client_sales WHERE company_id=$1 AND baseline_profile_id=$2', [companyId, req.params.profileId]);
    return { success: true };
  });

  // ─── PRODUCTION FORECASTS ───────────────────────────────────────────────────

  fastify.get('/production-forecasts', async (req, reply) => {
    const companyId = req.user.company_id;
    const { gte_month, lte_month, limit } = req.query;
    let q = 'SELECT * FROM production_forecasts WHERE company_id = $1';
    const params = [companyId];
    if (gte_month) { params.push(gte_month); q += ` AND forecast_month >= $${params.length}`; }
    if (lte_month) { params.push(lte_month); q += ` AND forecast_month <= $${params.length}`; }
    q += ' ORDER BY forecast_month DESC';
    if (limit) q += ` LIMIT ${parseInt(limit)}`;
    const { rows } = await db.query(q, params);
    return rows;
  });

  fastify.post('/production-forecasts', async (req, reply) => {
    const companyId = req.user.company_id;
    const body = req.body;
    if (Array.isArray(body)) {
      const results = [];
      for (const item of body) {
        const { rows } = await db.query(
          'INSERT INTO production_forecasts (company_id, forecast_month, production_volume_mt, rm_cost_per_mt) VALUES ($1,$2,$3,$4) RETURNING *',
          [companyId, item.forecast_month, item.production_volume_mt||null, item.rm_cost_per_mt||null]
        );
        results.push(rows[0]);
      }
      return results;
    }
    const { rows } = await db.query(
      'INSERT INTO production_forecasts (company_id, forecast_month, production_volume_mt, rm_cost_per_mt) VALUES ($1,$2,$3,$4) RETURNING *',
      [companyId, body.forecast_month, body.production_volume_mt||null, body.rm_cost_per_mt||null]
    );
    return rows[0];
  });

  fastify.patch('/production-forecasts/:id', async (req, reply) => {
    const companyId = req.user.company_id;
    const { id } = req.params;
    const fields = req.body;
    const allowed = ['forecast_month','production_volume_mt','rm_cost_per_mt'];
    const sets = []; const vals = [companyId, id];
    for (const k of allowed) {
      if (k in fields) { sets.push(`${k} = $${vals.push(fields[k])}`); }
    }
    if (!sets.length) return reply.code(400).send({ error: 'No fields' });
    const { rows } = await db.query(
      `UPDATE production_forecasts SET ${sets.join(',')} WHERE company_id=$1 AND id=$2 RETURNING *`,
      vals
    );
    return rows[0];
  });

  // ─── CURRENCY RATES ─────────────────────────────────────────────────────────

  fastify.get('/currency-rates', async (req, reply) => {
    const companyId = req.user.company_id;
    const { rows } = await db.query(
      'SELECT * FROM currency_rates WHERE company_id=$1 ORDER BY effective_date DESC',
      [companyId]
    );
    return rows;
  });

  fastify.post('/currency-rates', async (req, reply) => {
    const companyId = req.user.company_id;
    const { from_currency, to_currency, rate, effective_date } = req.body;
    const { rows } = await db.query(
      'INSERT INTO currency_rates (company_id, from_currency, to_currency, rate, effective_date) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [companyId, from_currency, to_currency, rate, effective_date || new Date().toISOString().split('T')[0]]
    );
    return rows[0];
  });

  // ─── SUPPLIER INVOICES ──────────────────────────────────────────────────────

  fastify.get('/supplier-invoices', async (req, reply) => {
    const companyId = req.user.company_id;
    const { supplier_ids, payment_status } = req.query;
    let q = `SELECT si.*, s.name AS supplier_name FROM supplier_invoices si
             LEFT JOIN suppliers s ON s.id = si.supplier_id
             WHERE si.company_id = $1`;
    const params = [companyId];
    if (supplier_ids) {
      const arr = supplier_ids.split(',');
      params.push(arr); q += ` AND si.supplier_id = ANY($${params.length})`;
    }
    if (payment_status === 'not_paid') {
      q += ` AND si.payment_status != 'paid'`;
    } else if (payment_status) {
      params.push(payment_status); q += ` AND si.payment_status = $${params.length}`;
    }
    q += ' ORDER BY si.invoice_date DESC';
    const { rows } = await db.query(q, params);
    return rows;
  });

  fastify.post('/supplier-invoices', async (req, reply) => {
    const companyId = req.user.company_id;
    const b = req.body;
    const { rows } = await db.query(
      `INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date, amount_sr, status, payment_status, notes, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [companyId, b.supplier_id, b.invoice_number, b.invoice_date, b.due_date||null, b.amount_sr, b.status||'Open', b.payment_status||'pending', b.notes||null, b.currency||'SAR']
    );
    return rows[0];
  });

  fastify.patch('/supplier-invoices/bulk-schedule', async (req, reply) => {
    const companyId = req.user.company_id;
    const { ids, scheduled_payment_date } = req.body;
    await db.query(
      `UPDATE supplier_invoices SET scheduled_payment_date=$3, status='Scheduled', payment_status='scheduled' WHERE company_id=$1 AND id = ANY($2)`,
      [companyId, ids, scheduled_payment_date]
    );
    return { success: true };
  });

  fastify.patch('/supplier-invoices/:id', async (req, reply) => {
    const companyId = req.user.company_id;
    const { id } = req.params;
    const fields = req.body;
    const allowed = ['invoice_number','invoice_date','due_date','amount_sr','scheduled_payment_date','actual_payment_date','status','payment_status','notes','currency'];
    const sets = []; const vals = [companyId, id];
    for (const k of allowed) {
      if (k in fields) { sets.push(`${k} = $${vals.push(fields[k])}`); }
    }
    if (!sets.length) return reply.code(400).send({ error: 'No fields' });
    const { rows } = await db.query(
      `UPDATE supplier_invoices SET ${sets.join(',')} WHERE company_id=$1 AND id=$2 RETURNING *`,
      vals
    );
    return rows[0];
  });

  fastify.delete('/supplier-invoices/bulk', async (req, reply) => {
    const companyId = req.user.company_id;
    const { ids } = req.body;
    await db.query('DELETE FROM supplier_invoices WHERE company_id=$1 AND id = ANY($2)', [companyId, ids]);
    return { success: true };
  });

  fastify.delete('/supplier-invoices/:id', async (req, reply) => {
    const companyId = req.user.company_id;
    await db.query('DELETE FROM supplier_invoices WHERE company_id=$1 AND id=$2', [companyId, req.params.id]);
    return { success: true };
  });

  // ─── CASH FLOW LEDGER ───────────────────────────────────────────────────────

  fastify.get('/cash-flow-ledger', async (req, reply) => {
    const companyId = req.user.company_id;
    const { gte_date, lte_date, statuses } = req.query;
    let q = 'SELECT * FROM cash_flow_ledger WHERE company_id = $1';
    const params = [companyId];
    if (gte_date) { params.push(gte_date); q += ` AND transaction_date >= $${params.length}`; }
    if (lte_date) { params.push(lte_date); q += ` AND transaction_date <= $${params.length}`; }
    if (statuses) {
      const arr = statuses.split(',');
      params.push(arr); q += ` AND status = ANY($${params.length})`;
    }
    q += ' ORDER BY transaction_date';
    const { rows } = await db.query(q, params);
    return rows;
  });

  // ─── CLIENT CONSUMPTION PROFILES ────────────────────────────────────────────

  fastify.get('/client-consumption-profiles', async (req, reply) => {
    const companyId = req.user.company_id;
    const { rows } = await db.query(
      `SELECT ccp.*, jsonb_build_object('name', c.name, 'client_code', COALESCE(c.client_code,'')) AS clients
       FROM client_consumption_profiles ccp
       LEFT JOIN clients c ON c.id = ccp.client_id
       WHERE ccp.company_id = $1
       ORDER BY ccp.created_at DESC`,
      [companyId]
    );
    return rows;
  });

  fastify.post('/client-consumption-profiles', async (req, reply) => {
    const companyId = req.user.company_id;
    const b = req.body;
    const { rows } = await db.query(
      `INSERT INTO client_consumption_profiles (company_id, client_id, material, baseline_monthly_quantity_mt, baseline_price_per_mt, tolerance_percent, notes, last_reviewed_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [companyId, b.client_id||null, b.material, b.baseline_monthly_quantity_mt, b.baseline_price_per_mt, b.tolerance_percent||10, b.notes||null, b.last_reviewed_date||null]
    );
    return rows[0];
  });

  fastify.patch('/client-consumption-profiles/:id', async (req, reply) => {
    const companyId = req.user.company_id;
    const { id } = req.params;
    const fields = req.body;
    const allowed = ['client_id','material','baseline_monthly_quantity_mt','baseline_price_per_mt','tolerance_percent','is_active','notes','last_reviewed_date'];
    const sets = []; const vals = [companyId, id];
    for (const k of allowed) {
      if (k in fields) { sets.push(`${k} = $${vals.push(fields[k])}`); }
    }
    if (!sets.length) return reply.code(400).send({ error: 'No fields' });
    const { rows } = await db.query(
      `UPDATE client_consumption_profiles SET ${sets.join(',')} WHERE company_id=$1 AND id=$2 RETURNING *`,
      vals
    );
    return rows[0];
  });

  fastify.delete('/client-consumption-profiles/:id', async (req, reply) => {
    const companyId = req.user.company_id;
    await db.query('DELETE FROM client_consumption_profiles WHERE company_id=$1 AND id=$2', [companyId, req.params.id]);
    return { success: true };
  });

  // ─── PRODUCTION ORDERS (cashflow reads) ─────────────────────────────────────

  fastify.get('/production-orders', async (req, reply) => {
    const companyId = req.user.company_id;
    const { invoice_status, invoice_sent_to_client, payment_received, statuses, has_production_date, or_condition } = req.query;
    let q = 'SELECT * FROM production_orders WHERE company_id = $1';
    const params = [companyId];
    if (invoice_status) { params.push(invoice_status); q += ` AND invoice_status = $${params.length}`; }
    if (invoice_sent_to_client !== undefined) { params.push(invoice_sent_to_client === 'true'); q += ` AND invoice_sent_to_client = $${params.length}`; }
    if (payment_received === 'not_true') { q += ` AND (payment_received IS NULL OR payment_received != true)`; }
    if (statuses) {
      const arr = statuses.split(',');
      params.push(arr); q += ` AND status = ANY($${params.length})`;
    }
    if (has_production_date === 'true') { q += ` AND expected_production_date IS NOT NULL`; }
    if (or_condition === 'invoice_not_invoiced') {
      q += ` AND (invoice_status IS NULL OR invoice_status != 'invoiced')`;
    }
    q += ' ORDER BY created_at DESC';
    const { rows } = await db.query(q, params);
    return rows;
  });

  fastify.patch('/production-orders/:id', async (req, reply) => {
    const companyId = req.user.company_id;
    const { id } = req.params;
    const fields = req.body;
    const allowed = ['expected_payment_date','expected_production_date','expected_invoicing_date'];
    const sets = []; const vals = [companyId, id];
    for (const k of allowed) {
      if (k in fields) { sets.push(`${k} = $${vals.push(fields[k])}`); }
    }
    if (!sets.length) return reply.code(400).send({ error: 'No fields' });
    const { rows } = await db.query(
      `UPDATE production_orders SET ${sets.join(',')} WHERE company_id=$1 AND id=$2 RETURNING *`,
      vals
    );
    return rows[0];
  });

  // ─── SUPPLIERS (cashflow credit fields) ─────────────────────────────────────

  fastify.get('/suppliers', async (req, reply) => {
    const companyId = req.user.company_id;
    const { status, payment_term_type, gt_credit_days, gt_average_monthly } = req.query;
    let q = 'SELECT * FROM suppliers WHERE company_id = $1';
    const params = [companyId];
    if (status) { params.push(status); q += ` AND status = $${params.length}`; }
    if (payment_term_type) { params.push(payment_term_type); q += ` AND payment_term_type = $${params.length}`; }
    if (gt_credit_days === 'true') { q += ` AND credit_days > 0`; }
    if (gt_average_monthly === 'true') { q += ` AND average_monthly_invoices > 0`; }
    q += ' ORDER BY name';
    const { rows } = await db.query(q, params);
    return rows;
  });

  fastify.patch('/suppliers/:id', async (req, reply) => {
    const companyId = req.user.company_id;
    const { id } = req.params;
    const fields = req.body;
    const allowed = ['credit_days','payment_term_type','average_monthly_invoices','name','status','payment_terms'];
    const sets = []; const vals = [companyId, id];
    for (const k of allowed) {
      if (k in fields) { sets.push(`${k} = $${vals.push(fields[k])}`); }
    }
    if (!sets.length) return reply.code(400).send({ error: 'No fields' });
    const { rows } = await db.query(
      `UPDATE suppliers SET ${sets.join(',')} WHERE company_id=$1 AND id=$2 RETURNING *`,
      vals
    );
    return rows[0];
  });

  // ─── GLOBAL CONFIG (cashflow reads) ─────────────────────────────────────────

  fastify.get('/global-config', async (req, reply) => {
    const companyId = req.user.company_id;
    const { keys } = req.query;
    let q = 'SELECT * FROM global_config WHERE company_id = $1';
    const params = [companyId];
    if (keys) {
      const arr = keys.split(',');
      params.push(arr); q += ` AND config_key = ANY($${params.length})`;
    }
    const { rows } = await db.query(q, params);
    return rows;
  });

  fastify.post('/global-config', async (req, reply) => {
    const companyId = req.user.company_id;
    const { config_key, config_value, description } = req.body;
    const { rows } = await db.query(
      `INSERT INTO global_config (company_id, config_key, config_value, description)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (company_id, config_key) DO UPDATE SET config_value = EXCLUDED.config_value
       RETURNING *`,
      [companyId, config_key, config_value, description||null]
    );
    return rows[0];
  });
}
