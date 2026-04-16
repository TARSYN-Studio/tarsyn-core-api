import { query, withTransaction } from '../db.js';

export default async function rfqScenarioRoutes(app) {

  // ── GET /api/sales/rfq/tracker ──────────────────────────────
  // Master order tracker — all RFQs with scenario status
  app.get('/rfq/tracker', { preHandler: [app.authenticate] }, async (request, _reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT r.id, r.rfq_number, r.status AS rfq_status,
              r.quantity_mt, r.material, r.port_of_destination,
              r.created_at,
              c.name AS client_name,
              s.id AS scenario_id,
              COALESCE(s.workflow_status, s.status) AS scenario_status,
              s.factory_submitted_at, s.logistics_submitted_at,
              s.ceo_approved_at, s.final_selling_price,
              s.total_cost_per_mt, s.suggested_selling_price,
              s.margin_pct,
              q.sent_at AS quotation_sent_at,
              q.client_confirmed_at
       FROM rfqs r
       LEFT JOIN clients c ON c.id = r.client_id
       LEFT JOIN rfq_scenarios s ON s.rfq_id = r.id
       LEFT JOIN rfq_quotations q ON q.rfq_id = r.id
       WHERE r.company_id = $1
       ORDER BY r.created_at DESC`,
      [company_id]
    );
    return { data: rows };
  });

  // ── GET /api/sales/rfq/:rfqId/scenario ──────────────────────
  app.get('/rfq/:rfqId/scenario', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rfqId } = request.params;
    const { rows } = await query(
      `SELECT s.*, r.rfq_number, r.quantity_mt, r.product_description, r.material,
              c.name AS client_name, c.contact_email AS client_email,
              r.port_of_load, r.port_of_destination
       FROM rfq_scenarios s
       JOIN rfqs r ON r.id = s.rfq_id
       LEFT JOIN clients c ON c.id = r.client_id
       WHERE s.rfq_id = $1 AND s.company_id = $2
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [rfqId, company_id]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Scenario not found for this RFQ' });
    return rows[0];
  });

  // ── POST /api/sales/rfq/:rfqId/scenario ─────────────────────
  // Create a scenario when RFQ is first set up
  app.post('/rfq/:rfqId/scenario', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { rfqId } = request.params;
    const { container_size = 20, shipping_responsibility = 'company' } = request.body ?? {};

    // Verify RFQ belongs to this company
    const { rows: rfqRows } = await query(
      `SELECT id FROM rfqs WHERE id = $1 AND company_id = $2`, [rfqId, company_id]
    );
    if (rfqRows.length === 0) return reply.status(404).send({ error: 'RFQ not found' });

    const { rows } = await withTransaction(async (client) => {
      const scenarioResult = await client.query(
        `INSERT INTO rfq_scenarios
           (rfq_id, company_id, container_size, shipping_responsibility, status, created_by)
         VALUES ($1, $2, $3, $4, 'pending_factory', $5)
         RETURNING *`,
        [rfqId, company_id, container_size, shipping_responsibility, user_id ?? null]
      );
      await client.query(
        `UPDATE rfqs SET status = 'pending_factory' WHERE id = $1`, [rfqId]
      );
      return scenarioResult;
    });
    return reply.status(201).send(rows[0]);
  });

  // ── POST /api/sales/rfq/:rfqId/factory-costing ──────────────
  app.post('/rfq/:rfqId/factory-costing', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { rfqId } = request.params;
    const {
      raw_material_cost_per_mt = 0,
      fixed_cost_per_mt = 0,
      packing_cost_per_mt = 0,
      extra_cost_per_mt = 0,
      extra_cost_reason,
    } = request.body ?? {};

    // Fetch current scenario
    const { rows: scenRows } = await query(
      `SELECT s.*, r.quantity_mt FROM rfq_scenarios s
       JOIN rfqs r ON r.id = s.rfq_id
       WHERE s.rfq_id = $1 AND s.company_id = $2
       ORDER BY s.created_at DESC LIMIT 1`,
      [rfqId, company_id]
    );
    if (scenRows.length === 0) return reply.status(404).send({ error: 'Scenario not found' });
    const scenario = scenRows[0];

    const rawCost    = parseFloat(raw_material_cost_per_mt) || 0;
    const fixedCost  = parseFloat(fixed_cost_per_mt) || 0;
    const packCost   = parseFloat(packing_cost_per_mt) || 0;
    const extraCost  = parseFloat(extra_cost_per_mt) || 0;
    const prodCostPerMt = rawCost + fixedCost + packCost + extraCost;

    // If client handles shipping, go straight to CEO
    const isClientShipping = scenario.shipping_responsibility === 'client';
    const suggestedPrice   = isClientShipping ? prodCostPerMt * 1.15 : null;
    const nextStatus       = isClientShipping ? 'pending_ceo' : 'pending_logistics';
    const totalCostPerMt   = isClientShipping ? prodCostPerMt : null;

    const { rows } = await withTransaction(async (client) => {
      const updateResult = await client.query(
        `UPDATE rfq_scenarios
         SET raw_material_cost_per_mt = $3,
             fixed_cost_per_mt        = $4,
             packing_cost_per_mt      = $5,
             extra_cost_per_mt        = $6,
             extra_cost_reason        = $7,
             factory_submitted_by     = $8,
             factory_submitted_at     = now(),
             total_cost_per_mt        = $9,
             suggested_selling_price  = $10,
             status                   = $11
         WHERE rfq_id = $1 AND company_id = $2
         RETURNING *`,
        [rfqId, company_id,
         rawCost, fixedCost, packCost, extraCost,
         extra_cost_reason ?? null, user_id ?? null,
         totalCostPerMt, suggestedPrice, nextStatus]
      );
      await client.query(
        `UPDATE rfqs SET status = $2 WHERE id = $1`, [rfqId, nextStatus]
      );
      return updateResult;
    });
    return rows[0];
  });

  // ── POST /api/sales/rfq/:rfqId/shipping-quote ───────────────
  app.post('/rfq/:rfqId/shipping-quote', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { rfqId } = request.params;
    const {
      container_cost_usd = 0,
      port_charges_usd   = 0,
      customs_clearance_usd = 0,
      exchange_rate      = 3.75,
    } = request.body ?? {};

    const { rows: scenRows } = await query(
      `SELECT * FROM rfq_scenarios WHERE rfq_id = $1 AND company_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [rfqId, company_id]
    );
    if (scenRows.length === 0) return reply.status(404).send({ error: 'Scenario not found' });
    const scenario = scenRows[0];

    const containerCost  = parseFloat(container_cost_usd) || 0;
    const portCharges    = parseFloat(port_charges_usd) || 0;
    const customsClear   = parseFloat(customs_clearance_usd) || 0;
    const exRate         = parseFloat(exchange_rate) || 3.75;
    const containerSize  = parseFloat(scenario.container_size) || 20;

    const totalShippingUsd    = containerCost + portCharges + customsClear;
    const shippingCostPerMt   = containerSize > 0 ? totalShippingUsd / containerSize : 0;
    const prodCost            = parseFloat(scenario.raw_material_cost_per_mt || 0)
                              + parseFloat(scenario.fixed_cost_per_mt || 0)
                              + parseFloat(scenario.packing_cost_per_mt || 0)
                              + parseFloat(scenario.extra_cost_per_mt || 0);
    const totalCostPerMt      = prodCost + shippingCostPerMt;
    const suggestedPrice      = totalCostPerMt * 1.15;

    const { rows } = await withTransaction(async (client) => {
      const updateResult = await client.query(
        `UPDATE rfq_scenarios
         SET container_cost_usd      = $3,
             port_charges_usd        = $4,
             customs_clearance_usd   = $5,
             total_shipping_usd      = $6,
             exchange_rate           = $7,
             shipping_cost_per_mt    = $8,
             total_cost_per_mt       = $9,
             suggested_selling_price = $10,
             logistics_submitted_by  = $11,
             logistics_submitted_at  = now(),
             status                  = 'pending_ceo'
         WHERE rfq_id = $1 AND company_id = $2
         RETURNING *`,
        [rfqId, company_id,
         containerCost, portCharges, customsClear,
         totalShippingUsd, exRate, shippingCostPerMt,
         totalCostPerMt, suggestedPrice, user_id ?? null]
      );
      await client.query(
        `UPDATE rfqs SET status = 'pending_ceo' WHERE id = $1`, [rfqId]
      );
      return updateResult;
    });
    return rows[0];
  });

  // ── POST /api/sales/rfq/:rfqId/approve ──────────────────────
  app.post('/rfq/:rfqId/approve', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { rfqId } = request.params;
    const { final_selling_price, ceo_notes } = request.body ?? {};

    if (!final_selling_price) return reply.status(400).send({ error: 'final_selling_price is required' });

    const { rows: scenRows } = await query(
      `SELECT * FROM rfq_scenarios WHERE rfq_id = $1 AND company_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [rfqId, company_id]
    );
    if (scenRows.length === 0) return reply.status(404).send({ error: 'Scenario not found' });
    const scenario = scenRows[0];

    const finalPrice    = parseFloat(final_selling_price);
    const totalCost     = parseFloat(scenario.total_cost_per_mt || 0);
    const marginPct     = finalPrice > 0
      ? ((finalPrice - totalCost) / finalPrice) * 100
      : 0;

    const { rows } = await withTransaction(async (client) => {
      const updateResult = await client.query(
        `UPDATE rfq_scenarios
         SET final_selling_price = $3,
             margin_pct          = $4,
             ceo_approved_by     = $5,
             ceo_approved_at     = now(),
             ceo_notes           = $6,
             status              = 'approved'
         WHERE rfq_id = $1 AND company_id = $2
         RETURNING *`,
        [rfqId, company_id, finalPrice, marginPct, user_id ?? null, ceo_notes ?? null]
      );
      await client.query(
        `UPDATE rfqs SET status = 'approved', price_per_mt = $2 WHERE id = $1`,
        [rfqId, finalPrice]
      );
      return updateResult;
    });
    return rows[0];
  });

  // ── POST /api/sales/rfq/:rfqId/send-quotation ───────────────
  app.post('/rfq/:rfqId/send-quotation', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { rfqId } = request.params;
    const { method = 'email', recipient_email } = request.body ?? {};

    const { rows: scenRows } = await query(
      `SELECT * FROM rfq_scenarios WHERE rfq_id = $1 AND company_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [rfqId, company_id]
    );
    if (scenRows.length === 0) return reply.status(404).send({ error: 'Scenario not found' });
    const scenario = scenRows[0];

    if (recipient_email) {
      console.log(`[RFQ] Quotation email queued to ${recipient_email} for RFQ ${rfqId}`);
    }

    const { rows } = await withTransaction(async (client) => {
      const quotResult = await client.query(
        `INSERT INTO rfq_quotations
           (rfq_id, scenario_id, company_id, sent_method, sent_at, sent_by)
         VALUES ($1, $2, $3, $4, now(), $5)
         RETURNING *`,
        [rfqId, scenario.id, company_id, method, user_id ?? null]
      );
      await client.query(
        `UPDATE rfq_scenarios SET status = 'quotation_sent' WHERE id = $1`, [scenario.id]
      );
      await client.query(
        `UPDATE rfqs SET status = 'quotation_sent' WHERE id = $1`, [rfqId]
      );
      return quotResult;
    });
    return reply.status(201).send(rows[0]);
  });

  // ── POST /api/sales/rfq/:rfqId/confirm ──────────────────────
  app.post('/rfq/:rfqId/confirm', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { rfqId } = request.params;
    const { final_agreed_price, po_number, outcome = 'spot_order' } = request.body ?? {};

    // Fetch RFQ + latest quotation + scenario
    const { rows: rfqRows } = await query(
      `SELECT r.*, c.name AS client_name FROM rfqs r
       LEFT JOIN clients c ON c.id = r.client_id
       WHERE r.id = $1 AND r.company_id = $2`,
      [rfqId, company_id]
    );
    if (rfqRows.length === 0) return reply.status(404).send({ error: 'RFQ not found' });
    const rfq = rfqRows[0];

    const { rows: scenRows } = await query(
      `SELECT * FROM rfq_scenarios WHERE rfq_id = $1 AND company_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [rfqId, company_id]
    );
    const scenario = scenRows[0] ?? null;

    const agreedPrice = parseFloat(final_agreed_price ?? rfq.price_per_mt ?? 0);

    const result = await withTransaction(async (client) => {
      // Update quotation record if one exists
      await client.query(
        `UPDATE rfq_quotations
         SET client_confirmed_at = now(),
             final_agreed_price  = $2,
             po_number           = $3,
             outcome             = $4
         WHERE rfq_id = $1`,
        [rfqId, agreedPrice, po_number ?? null, outcome]
      );

      if (scenario) {
        await client.query(
          `UPDATE rfq_scenarios SET status = 'confirmed' WHERE id = $1`, [scenario.id]
        );
      }
      await client.query(
        `UPDATE rfqs SET status = 'confirmed' WHERE id = $1`, [rfqId]
      );

      let productionOrder = null;
      let salesOrder = null;

      if (outcome === 'spot_order') {
        // Auto-create production order
        const poNum = po_number ?? `PO-${rfq.rfq_number ?? rfqId.substring(0, 8).toUpperCase()}`;
        const poResult = await client.query(
          `INSERT INTO production_orders
             (company_id, po_number, client_id, client_name, material,
              quantity, price_per_mt_usd, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_review', $8)
           RETURNING *`,
          [company_id, poNum, rfq.client_id ?? null, rfq.client_name ?? null,
           rfq.material ?? rfq.product_description ?? null,
           rfq.quantity_mt ?? null, agreedPrice, user_id ?? null]
        );
        productionOrder = poResult.rows[0];

        // Auto-create sales order
        const totalValue = agreedPrice && rfq.quantity_mt
          ? agreedPrice * parseFloat(rfq.quantity_mt)
          : null;
        const soResult = await client.query(
          `INSERT INTO sales_orders
             (company_id, rfq_id, client_id, quantity_mt, price_per_mt,
              total_value, currency, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed')
           RETURNING *`,
          [company_id, rfqId, rfq.client_id ?? null,
           rfq.quantity_mt ?? null, agreedPrice, totalValue, rfq.currency ?? 'USD']
        );
        salesOrder = soResult.rows[0];

      } else if (outcome === 'yearly_contract') {
        // Create basic contract record
        const contractNum = `CNT-${rfq.rfq_number ?? rfqId.substring(0, 8).toUpperCase()}`;
        const now = new Date();
        const nextYear = new Date(now);
        nextYear.setFullYear(now.getFullYear() + 1);
        const contractResult = await client.query(
          `INSERT INTO contracts
             (company_id, parent_client_id, contract_number,
              total_mt, remaining_mt, price_per_mt, currency,
              start_date, end_date, payment_terms, status)
           VALUES ($1, $2, $3, $4, $4, $5, $6,
                   $7::date, $8::date, 'spot', 'active')
           RETURNING *`,
          [company_id, rfq.client_id ?? null, contractNum,
           rfq.quantity_mt ?? 0, agreedPrice, rfq.currency ?? 'USD',
           now.toISOString().split('T')[0], nextYear.toISOString().split('T')[0]]
        );
        salesOrder = contractResult.rows[0];
      }

      return { productionOrder, salesOrder };
    });

    return { success: true, outcome, ...result };
  });

  // ── POST /api/sales/rfq/:rfqId/send-reminder ────────────────
  app.post('/rfq/:rfqId/send-reminder', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { rfqId } = request.params;
    const { remind_who = 'factory' } = request.body ?? {};
    console.log(`[RFQ] Reminder sent to ${remind_who} for RFQ ${rfqId}`);
    return { success: true, remind_who, rfq_id: rfqId };
  });
}

