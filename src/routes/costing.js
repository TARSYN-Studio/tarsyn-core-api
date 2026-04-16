import { query } from '../db.js';

export default async function costingRoutes(app) {

  // ── GET /api/costing/cost-components ─────────────────────────
  app.get('/cost-components', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    const { rows } = await query(
      'SELECT * FROM cost_components WHERE company_id = $1 AND is_active = true ORDER BY category, name',
      [company_id]
    );
    return rows;
  });

  // ── POST /api/costing/cost-components ────────────────────────
  app.post('/cost-components', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    const { name, category, calculation_type, value, currency = 'SAR', is_deduction = false, is_active = true } = req.body;
    const { rows } = await query(
      `INSERT INTO cost_components (company_id, name, category, calculation_type, value, currency, is_deduction, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [company_id, name, category, calculation_type, value, currency, is_deduction, is_active]
    );
    return reply.status(201).send(rows[0]);
  });

  // ── PATCH /api/costing/cost-components/:id ───────────────────
  app.patch('/cost-components/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    const { id } = req.params;
    const body = req.body;
    const sets = ['updated_at = now()'];
    const params = [id, company_id];
    let p = 3;
    const allowed = ['name','category','calculation_type','value','currency','is_deduction','is_active','client_id','remarks'];
    allowed.forEach(k => {
      if (body[k] !== undefined) { sets.push(`${k} = $${p++}`); params.push(body[k]); }
    });
    const { rows } = await query(
      `UPDATE cost_components SET ${sets.join(', ')} WHERE id = $1 AND company_id = $2 RETURNING *`,
      params
    );
    if (!rows.length) return reply.status(404).send({ error: 'Not found' });
    return rows[0];
  });

  // ── DELETE /api/costing/cost-components/:id ──────────────────
  app.delete('/cost-components/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    await query('DELETE FROM cost_components WHERE id = $1 AND company_id = $2', [req.params.id, company_id]);
    return reply.status(204).send();
  });

  // ── GET /api/costing/plant-costs ─────────────────────────────
  app.get('/plant-costs', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    const { month_year } = req.query;
    const conditions = ['company_id = $1'];
    const params = [company_id];
    let p = 2;
    if (month_year) { conditions.push(`month_year = $${p++}`); params.push(month_year); }
    const { rows } = await query(
      `SELECT * FROM plant_costs WHERE ${conditions.join(' AND ')} ORDER BY month_year DESC`,
      params
    );
    return rows;
  });

  // ── POST /api/costing/plant-costs ────────────────────────────
  app.post('/plant-costs', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    const b = req.body;
    const { rows } = await query(
      `INSERT INTO plant_costs (company_id, month_year, total_monthly_payroll, total_monthly_management,
        payroll_cost_per_mt, electricity_cost_per_mt, management_cost_per_mt, monthly_production_volume_mt, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (company_id, month_year) DO UPDATE SET
         total_monthly_payroll = EXCLUDED.total_monthly_payroll,
         total_monthly_management = EXCLUDED.total_monthly_management,
         payroll_cost_per_mt = EXCLUDED.payroll_cost_per_mt,
         electricity_cost_per_mt = EXCLUDED.electricity_cost_per_mt,
         management_cost_per_mt = EXCLUDED.management_cost_per_mt,
         monthly_production_volume_mt = EXCLUDED.monthly_production_volume_mt,
         notes = EXCLUDED.notes,
         updated_at = now()
       RETURNING *`,
      [company_id, b.month_year, b.total_monthly_payroll ?? null, b.total_monthly_management ?? null,
       b.payroll_cost_per_mt ?? null, b.electricity_cost_per_mt ?? null, b.management_cost_per_mt ?? null,
       b.monthly_production_volume_mt ?? null, b.notes ?? null]
    );
    return rows[0];
  });

  // ── PATCH /api/costing/plant-costs/:id ───────────────────────
  app.patch('/plant-costs/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    const { id } = req.params;
    const b = req.body;
    const sets = ['updated_at = now()'];
    const params = [id, company_id];
    let p = 3;
    const allowed = ['month_year','total_monthly_payroll','total_monthly_management','payroll_cost_per_mt',
      'electricity_cost_per_mt','management_cost_per_mt','monthly_production_volume_mt','notes'];
    allowed.forEach(k => {
      if (b[k] !== undefined) { sets.push(`${k} = $${p++}`); params.push(b[k]); }
    });
    const { rows } = await query(
      `UPDATE plant_costs SET ${sets.join(', ')} WHERE id = $1 AND company_id = $2 RETURNING *`,
      params
    );
    if (!rows.length) return reply.status(404).send({ error: 'Not found' });
    return rows[0];
  });

  // ── DELETE /api/costing/plant-costs/:id ──────────────────────
  app.delete('/plant-costs/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    await query('DELETE FROM plant_costs WHERE id = $1 AND company_id = $2', [req.params.id, company_id]);
    return reply.status(204).send();
  });

  // ── GET /api/costing/rfq-scenarios ───────────────────────────
  app.get('/rfq-scenarios', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    const { status, workflow_status, workflow_statuses } = req.query;
    const conditions = ['r.company_id = $1'];
    const params = [company_id];
    let p = 2;
    if (status) { conditions.push(`r.status = $${p++}`); params.push(status); }
    if (workflow_status) { conditions.push(`r.workflow_status = $${p++}`); params.push(workflow_status); }
    if (workflow_statuses) {
      const statuses = workflow_statuses.split(',');
      conditions.push(`r.workflow_status = ANY($${p++})`);
      params.push(statuses);
    }
    const { rows } = await query(
      `SELECT r.*,
         COALESCE(r.sales_rfq_id, rfq.rfq_number, rfq.id::text) AS resolved_rfq_ref,
         COALESCE(r.production_volume_mt, rfq.quantity_mt) AS resolved_volume,
         COALESCE(r.destination_port, rfq.port_of_destination) AS resolved_destination,
         rfq.rfq_number,
         rfq.material AS rfq_material,
         rfq.order_type AS rfq_order_type,
         rfq.shipping_handled_by AS rfq_shipping_handled_by,
         rfq.container_capacity AS rfq_container_capacity,
         jsonb_build_object(
           'name', COALESCE(c.name, c2.name, 'Unknown'),
           'client_code', COALESCE(c.client_code, c2.client_code, ''),
           'email', COALESCE(c.contact_email, c2.contact_email, ''),
           'port_of_destination', COALESCE(c.port_of_destination, c2.port_of_destination)
         ) AS clients
       FROM rfq_scenarios r
       LEFT JOIN rfqs rfq ON rfq.id = r.rfq_id
       LEFT JOIN clients c ON c.id = r.client_id
       LEFT JOIN clients c2 ON c2.id = rfq.client_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY r.created_at DESC`,
      params
    );
    // Merge resolved fields into each row for backward compat
    const enriched = rows.map(row => ({
      ...row,
      sales_rfq_id: row.resolved_rfq_ref || row.sales_rfq_id,
      production_volume_mt: row.resolved_volume || row.production_volume_mt,
      destination_port: row.resolved_destination || row.destination_port,
      material: row.material || row.rfq_material,
      order_type: row.order_type || row.rfq_order_type,
      shipping_handled_by: row.shipping_handled_by || row.rfq_shipping_handled_by,
      container_capacity_mt: row.container_capacity_mt || row.rfq_container_capacity,
    }));
    return enriched;
  });

  // ── GET /api/costing/rfq-scenarios/:id ───────────────────────
  app.get('/rfq-scenarios/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    const { rows } = await query(
      `SELECT r.*, jsonb_build_object('name', c.name, 'client_code', COALESCE(c.client_code,''), 'email', COALESCE(c.contact_email,'')) AS clients
       FROM rfq_scenarios r LEFT JOIN clients c ON c.id = r.client_id WHERE r.id = $1 AND r.company_id = $2`,
      [req.params.id, company_id]
    );
    if (!rows.length) return reply.status(404).send({ error: 'RFQ not found' });
    return rows[0];
  });

  // ── POST /api/costing/rfq-scenarios ──────────────────────────
  app.post('/rfq-scenarios', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id, sub: created_by } = req.user;
    const b = req.body;
    const { rows } = await query(
      `INSERT INTO rfq_scenarios (company_id, rfq_reference, sales_rfq_id, client_id, destination_port,
        production_volume_mt, rm_cost_sr_per_mt, manpower_cost_sr_per_mt, electricity_cost_sr_per_mt,
        management_cost_sr_per_mt, container_capacity_mt, freight_cost_usd_per_container,
        shipping_cost_usd_per_container, target_margin_percentage, total_cost_fob_usd,
        selling_price_cfr_usd, actual_margin_percentage, competitor_benchmark_price,
        final_selling_price, cost_snapshot, status, workflow_status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       RETURNING *`,
      [company_id, b.rfq_reference, b.sales_rfq_id ?? null, b.client_id ?? null, b.destination_port ?? null,
       b.production_volume_mt ?? null, b.rm_cost_sr_per_mt ?? null, b.manpower_cost_sr_per_mt ?? null,
       b.electricity_cost_sr_per_mt ?? null, b.management_cost_sr_per_mt ?? null, b.container_capacity_mt ?? null,
       b.freight_cost_usd_per_container ?? null, b.shipping_cost_usd_per_container ?? null,
       b.target_margin_percentage ?? null, b.total_cost_fob_usd ?? null, b.selling_price_cfr_usd ?? null,
       b.actual_margin_percentage ?? null, b.competitor_benchmark_price ?? null, b.final_selling_price ?? null,
       b.cost_snapshot ? JSON.stringify(b.cost_snapshot) : null,
       b.status ?? 'draft', b.workflow_status ?? 'draft', created_by]
    );
    return reply.status(201).send(rows[0]);
  });

  // ── PATCH /api/costing/rfq-scenarios/:id ─────────────────────
  app.patch('/rfq-scenarios/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    const { id } = req.params;
    const b = req.body;
    const sets = ['updated_at = now()'];
    const params = [id, company_id];
    let p = 3;
    const fields = ['rfq_reference','sales_rfq_id','client_id','destination_port','production_volume_mt',
      'rm_cost_sr_per_mt','manpower_cost_sr_per_mt','electricity_cost_sr_per_mt','management_cost_sr_per_mt',
      'container_capacity_mt','freight_cost_usd_per_container','shipping_cost_usd_per_container',
      'target_margin_percentage','total_cost_fob_usd','selling_price_cfr_usd','actual_margin_percentage',
      'competitor_benchmark_price','final_selling_price','status','workflow_status',
      'costs_submitted_at','costs_submitted_by','shipping_submitted_at','shipping_cost_submitted_at',
      'admin_approved_by','admin_approved_at','admin_notes',
      'approved_by','approved_at','workflow_notes','rejection_reason','offer_sent_at',
      'container_cost_usd','port_charges_usd','customs_clearance_usd','exchange_rate',
      'shipping_cost_per_mt','total_shipping_usd','logistics_submitted_by','logistics_submitted_at',
      'shipping_company_id','logistics_partner_id',
      'raw_material_cost_per_mt','fixed_cost_per_mt','packing_cost_per_mt','extra_cost_per_mt','extra_cost_reason',
      'factory_submitted_by','factory_submitted_at',
      'total_cost_per_mt','suggested_selling_price','margin_pct',
      'ceo_approved_by','ceo_approved_at','ceo_notes'];
    fields.forEach(k => {
      if (b[k] !== undefined) { sets.push(`${k} = $${p++}`); params.push(b[k]); }
    });
    if (b.cost_snapshot !== undefined) {
      sets.push(`cost_snapshot = $${p++}`);
      params.push(JSON.stringify(b.cost_snapshot));
    }
    const { rows } = await query(
      `UPDATE rfq_scenarios SET ${sets.join(', ')} WHERE id = $1 AND company_id = $2 RETURNING *`,
      params
    );
    if (!rows.length) return reply.status(404).send({ error: 'RFQ not found' });
    return rows[0];
  });

  // ── DELETE /api/costing/rfq-scenarios/:id ────────────────────
  app.delete('/rfq-scenarios/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    await query('DELETE FROM rfq_scenarios WHERE id = $1 AND company_id = $2', [req.params.id, company_id]);
    return reply.status(204).send();
  });

  // ── GET /api/costing/global-config ───────────────────────────
  app.get('/global-config', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    const { rows } = await query(
      'SELECT id, key AS config_key, CAST(value AS TEXT)::numeric AS config_value, description FROM global_config WHERE company_id = $1',
      [company_id]
    );
    return rows;
  });

  // ── POST /api/costing/global-config ──────────────────────────
  app.post('/global-config', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    const { key, value } = req.body;
    const { rows } = await query(
      `INSERT INTO global_config (company_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       RETURNING *`,
      [company_id, key, JSON.stringify(value)]
    );
    return rows[0];
  });

  // ── GET /api/costing/admin-payroll ───────────────────────────
  app.get('/admin-payroll', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    const { rows } = await query(
      'SELECT * FROM admin_payroll WHERE company_id = $1 ORDER BY payment_month DESC',
      [company_id]
    );
    return rows;
  });

  // ── POST /api/costing/admin-payroll ──────────────────────────
  app.post('/admin-payroll', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id, sub: created_by } = req.user;
    const records = Array.isArray(req.body) ? req.body : [req.body];
    const inserted = [];
    for (const rec of records) {
      const { rows } = await query(
        `INSERT INTO admin_payroll (company_id, employee_name, employee_id, position, basic_salary,
          allowances, deductions, net_salary, payment_month, payment_status, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [company_id, rec.employee_name, rec.employee_id ?? null, rec.position ?? null,
         rec.basic_salary ?? null, rec.allowances ?? 0, rec.deductions ?? 0, rec.net_salary ?? null,
         rec.payment_month ?? null, rec.payment_status ?? 'pending', rec.notes ?? null, created_by]
      );
      inserted.push(rows[0]);
    }
    return reply.status(201).send(inserted);
  });

  // ── GET /api/costing/labour-categories ───────────────────────
  app.get('/labour-categories', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    const { rows } = await query(
      `SELECT id, company_id, name AS category_name, description, overtime_rate, holiday_overtime_rate, is_active, created_at
       FROM labour_categories WHERE company_id = $1 AND is_active = true ORDER BY name`,
      [company_id]
    );
    return rows;
  });

  // ── GET /api/costing/factory-labour-payroll ──────────────────
  app.get('/factory-labour-payroll', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    const { rows } = await query(
      'SELECT * FROM factory_labour_payroll WHERE company_id = $1 ORDER BY payment_month DESC',
      [company_id]
    );
    return rows;
  });

  // ── POST /api/costing/factory-labour-payroll ─────────────────
  app.post('/factory-labour-payroll', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id, sub: created_by } = req.user;
    const records = Array.isArray(req.body) ? req.body : [req.body];
    const inserted = [];
    for (const rec of records) {
      // Look up category rates if worker_category is provided
      let overtimeRate = 0, holidayRate = 0;
      if (rec.worker_category) {
        const { rows: cats } = await query(
          'SELECT overtime_rate, holiday_overtime_rate FROM labour_categories WHERE company_id = $1 AND name = $2 LIMIT 1',
          [company_id, rec.worker_category]
        );
        if (cats.length) {
          overtimeRate = parseFloat(cats[0].overtime_rate) || 0;
          holidayRate = parseFloat(cats[0].holiday_overtime_rate) || 0;
        }
      }

      // Calculate derived fields
      const basicSalary = parseFloat(rec.basic_salary) || 0;
      const foodAllowance = parseFloat(rec.food_allowance) || 0;
      const regularWorkDays = parseFloat(rec.regular_work_days) || 30;
      const overtimeHours = parseFloat(rec.overtime_hours) || 0;
      const offDaysWorked = parseFloat(rec.off_days_worked) || 0;

      const totalPackage = basicSalary + foodAllowance;
      const deservedSalary = (totalPackage / 30) * regularWorkDays;
      const totalOtAmount = overtimeHours * overtimeRate;
      const offDayNormalPay = offDaysWorked * (basicSalary / 30);
      const offDayExtraHoursPay = offDaysWorked * 3 * holidayRate;
      const totalOffDayAmount = offDayNormalPay + offDayExtraHoursPay;
      const grossSalary = deservedSalary + totalOtAmount + totalOffDayAmount;
      const netSalary = grossSalary;

      const { rows } = await query(
        `INSERT INTO factory_labour_payroll (company_id, employee_name, pay_roll_number, worker_category,
          basic_salary, food_allowance, regular_work_days, overtime_hours, off_days_worked,
          total_package, deserved_salary, total_ot_amount, off_day_normal_pay, off_day_extra_hours_pay,
          total_off_day_amount, gross_salary, net_salary,
          payment_month, payment_status, remarks, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
        [company_id, rec.employee_name, rec.pay_roll_number ?? null, rec.worker_category ?? null,
         basicSalary, foodAllowance, regularWorkDays, overtimeHours, offDaysWorked,
         totalPackage, deservedSalary, totalOtAmount, offDayNormalPay, offDayExtraHoursPay,
         totalOffDayAmount, grossSalary, netSalary,
         rec.payment_month ?? null, rec.payment_status ?? 'pending',
         rec.remarks ?? null, rec.notes ?? null, created_by]
      );
      inserted.push(rows[0]);
    }
    return reply.status(201).send(inserted);
  });

  // ── GET /api/costing/email-queue ─────────────────────────────
  app.get('/email-queue', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    const { transaction_type, email_type } = req.query;
    const conditions = ['company_id = $1'];
    const params = [company_id];
    let p = 2;
    if (transaction_type) {
      const types = transaction_type.split(',');
      conditions.push(`transaction_type = ANY($${p++})`);
      params.push(types);
    }
    if (email_type) { conditions.push(`email_type = $${p++}`); params.push(email_type); }
    const { rows } = await query(
      `SELECT * FROM email_queue WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
      params
    );
    return rows;
  });

  // ── PATCH /api/costing/email-queue/:id ───────────────────────
  app.patch('/email-queue/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { company_id } = req.user;
    const b = req.body;
    const sets = ['updated_at = now()'];
    const params = [req.params.id, company_id];
    let p = 3;
    const allowed = ['status','sent_at','error_message'];
    allowed.forEach(k => {
      if (b[k] !== undefined) { sets.push(`${k} = $${p++}`); params.push(b[k]); }
    });
    const { rows } = await query(
      `UPDATE email_queue SET ${sets.join(', ')} WHERE id = $1 AND company_id = $2 RETURNING *`,
      params
    );
    if (!rows.length) return reply.status(404).send({ error: 'Not found' });
    return rows[0];
  });

  // ── POST /api/costing/email-queue/:id/send ───────────────────
  app.post('/email-queue/:id/send', { preHandler: [app.authenticate] }, async (req, reply) => {
    console.log('[costing email-queue send stub]', req.params.id, req.body);
    // Update status to sent
    const { company_id } = req.user;
    await query(
      'UPDATE email_queue SET status = $1, sent_at = now(), updated_at = now() WHERE id = $2 AND company_id = $3',
      ['sent', req.params.id, company_id]
    );
    return reply.status(200).send({ success: true, message: 'Email sending not yet configured on this server' });
  });
}
