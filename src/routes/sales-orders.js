import { query } from '../db.js';
import { reverseDocument, cancelDocument, sendReversalError, ReversalError } from '../services/reversal.js';

// ── Helper: next payment schedule date ───────────────────────────
function nextScheduleDate(baseDate, scheduleDays) {
  const base = new Date(baseDate);
  const year = base.getFullYear();
  const month = base.getMonth(); // 0-indexed

  // Sort schedule days ascending
  const sorted = [...scheduleDays].sort((a, b) => a - b);

  // Try current month first, then next month
  for (let offset = 0; offset <= 2; offset++) {
    const m = month + offset;
    const y = year + Math.floor(m / 12);
    const mo = m % 12;
    for (const day of sorted) {
      const candidate = new Date(y, mo, day);
      if (candidate > base) return candidate.toISOString().split('T')[0];
    }
  }
  return null;
}

// ── Helper: calculate payment_due_date ───────────────────────────
function calcPaymentDueDate(contract, blDate, arrivalDate) {
  if (!contract) {
    // Spot — 5 days from invoice (use arrival as proxy)
    if (!arrivalDate) return null;
    const d = new Date(arrivalDate);
    d.setDate(d.getDate() + 5);
    return d.toISOString().split('T')[0];
  }

  if (contract.payment_terms === '60_days') {
    const dates = [blDate, arrivalDate].filter(Boolean).map(d => new Date(d));
    if (dates.length === 0) return null;
    const bl60 = blDate ? new Date(new Date(blDate).setDate(new Date(blDate).getDate() + 60)) : null;
    const arrDate = arrivalDate ? new Date(arrivalDate) : null;
    const base = bl60 && arrDate ? (bl60 > arrDate ? bl60 : arrDate) : (bl60 || arrDate);
    return base ? base.toISOString().split('T')[0] : null;
  }

  if (contract.payment_terms === 'custom' && contract.payment_schedule_dates?.length) {
    const bl60 = blDate ? new Date(new Date(blDate).setDate(new Date(blDate).getDate() + 60)) : null;
    const arrDate = arrivalDate ? new Date(arrivalDate) : null;
    const base = bl60 && arrDate ? (bl60 > arrDate ? bl60 : arrDate) : (bl60 || arrDate || new Date());
    return nextScheduleDate(base, contract.payment_schedule_dates);
  }

  // spot payment_terms — 5 days from arrival
  if (!arrivalDate) return null;
  const d = new Date(arrivalDate);
  d.setDate(d.getDate() + 5);
  return d.toISOString().split('T')[0];
}

export default async function salesOrdersRoutes(app) {

  // ── GET /api/sales-orders/rfqs ────────────────────────────────
  app.get('/rfqs', { preHandler: [app.authenticate] }, async (request, _reply) => {
    const { company_id } = request.user;
    const { status, client_id } = request.query;

    const conditions = ['r.company_id = $1'];
    const params = [company_id];
    let p = 2;
    if (status)    { conditions.push(`r.status    = $${p++}`); params.push(status); }
    if (client_id) { conditions.push(`r.client_id = $${p++}`); params.push(client_id); }

    const { rows } = await query(
      `SELECT r.*, cl.name AS client_name, c.contract_number
       FROM rfqs r
       LEFT JOIN clients cl ON cl.id = r.client_id
       LEFT JOIN contracts c ON c.id = r.contract_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY r.created_at DESC`,
      params
    );
    return { data: rows };
  });

  // ── POST /api/sales-orders/rfqs ──────────────────────────────
  app.post('/rfqs', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['client_id'],
        properties: {
          rfq_number:           { type: 'string' },
          client_id:            { type: 'string' },
          contract_id:          { type: 'string' },
          product_description:  { type: 'string' },
          quantity_mt:          { type: 'number' },
          price_per_mt:         { type: 'number' },
          currency:             { type: 'string', default: 'USD' },
          validity_date:        { type: 'string' },
          notes:                { type: 'string' },
          material:             { type: 'string' },
          port_of_load:         { type: 'string' },
          port_of_destination:  { type: 'string' },
          container_capacity:   { type: 'number', default: 20 },
          shipping_handled_by:  { type: 'string', default: 'company' },
          order_type:           { type: 'string', default: 'spot' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: created_by } = request.user;
    const {
      rfq_number, client_id, contract_id, product_description,
      quantity_mt, price_per_mt, currency = 'USD', validity_date, notes,
      material, port_of_load, port_of_destination,
      container_capacity = 20, shipping_handled_by = 'company', order_type = 'spot',
    } = request.body;

    // Auto-generate sequential RFQ number: RFQ-YYYY-NNNN
    let autoNumber = rfq_number;
    if (!autoNumber) {
      const year = new Date().getFullYear();
      const prefix = `RFQ-${year}-`;
      const { rows: seqRows } = await query(
        `SELECT rfq_number FROM rfqs WHERE company_id = $1 AND rfq_number LIKE $2 ORDER BY rfq_number DESC LIMIT 1`,
        [company_id, prefix + '%']
      );
      let nextSeq = 1;
      if (seqRows.length > 0 && seqRows[0].rfq_number) {
        const lastNum = parseInt(seqRows[0].rfq_number.replace(prefix, ''), 10);
        if (!isNaN(lastNum)) nextSeq = lastNum + 1;
      }
      autoNumber = prefix + String(nextSeq).padStart(4, '0');
    }

    const { rows } = await query(
      `INSERT INTO rfqs
         (company_id, rfq_number, client_id, contract_id, product_description,
          quantity_mt, price_per_mt, currency, validity_date, notes, created_by,
          material, port_of_load, port_of_destination,
          container_capacity, shipping_handled_by, order_type, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'pending_factory')
       RETURNING *`,
      [company_id, autoNumber, client_id, contract_id ?? null,
       product_description ?? null, quantity_mt ?? null, price_per_mt ?? null,
       currency, validity_date ?? null, notes ?? null, created_by,
       material ?? null, port_of_load ?? null, port_of_destination ?? null,
       container_capacity, shipping_handled_by, order_type]
    );
    const rfqRow = rows[0];

    // Auto-create rfq_scenarios record
    try {
      await query(
        `INSERT INTO rfq_scenarios
           (rfq_id, company_id, container_size, shipping_responsibility, status, workflow_status, created_by)
         VALUES ($1, $2, $3, $4, 'pending_factory', 'pending_costs', $5)`,
        [rfqRow.id, company_id, container_capacity, shipping_handled_by, created_by ?? null]
      );
    } catch (scenErr) {
      console.error('[RFQ] Auto-scenario creation failed:', scenErr.message);
    }

    return reply.status(201).send(rfqRow);
  });

  // ── PATCH /api/sales-orders/rfqs/:id ─────────────────────────
  // status=accepted auto-creates a sales order
  app.patch('/rfqs/:id', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          rfq_number:          { type: 'string' },
          product_description: { type: 'string' },
          quantity_mt:         { type: 'number' },
          price_per_mt:        { type: 'number' },
          currency:            { type: 'string' },
          validity_date:       { type: 'string' },
          status:              { type: 'string' },
          notes:               { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { rfq_number, product_description, quantity_mt, price_per_mt, currency, validity_date, status, notes } = request.body;

    const { rows: existing } = await query(
      `SELECT * FROM rfqs WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) return reply.status(404).send({ error: 'RFQ not found' });

    const { rows } = await query(
      `UPDATE rfqs
       SET rfq_number          = COALESCE($3, rfq_number),
           product_description = COALESCE($4, product_description),
           quantity_mt         = COALESCE($5, quantity_mt),
           price_per_mt        = COALESCE($6, price_per_mt),
           currency            = COALESCE($7, currency),
           validity_date       = COALESCE($8, validity_date),
           status              = COALESCE($9, status),
           notes               = COALESCE($10, notes)
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [id, company_id, rfq_number, product_description, quantity_mt,
       price_per_mt, currency, validity_date, status, notes]
    );

    let createdOrder = null;

    // Auto-create sales order when RFQ is accepted
    if (status === 'accepted' && existing[0].status !== 'accepted') {
      const rfq = rows[0];
      const total_value = (rfq.price_per_mt && rfq.quantity_mt)
        ? parseFloat(rfq.price_per_mt) * parseFloat(rfq.quantity_mt)
        : null;

      // Auto-generate SO number
      const soYear = new Date().getFullYear();
      const soPrefix = `SO-${soYear}-`;
      const { rows: soSeqRows } = await query(
        `SELECT order_number FROM sales_orders WHERE company_id = $1 AND order_number LIKE $2 ORDER BY order_number DESC LIMIT 1`,
        [company_id, soPrefix + '%']
      );
      let soNextSeq = 1;
      if (soSeqRows.length > 0 && soSeqRows[0].order_number) {
        const lastNum = parseInt(soSeqRows[0].order_number.replace(soPrefix, ''), 10);
        if (!isNaN(lastNum)) soNextSeq = lastNum + 1;
      }
      const soNumber = soPrefix + String(soNextSeq).padStart(4, '0');

      const { rows: soRows } = await query(
        `INSERT INTO sales_orders
           (company_id, order_number, rfq_id, client_id, contract_id, quantity_mt,
            price_per_mt, total_value, currency, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed')
         RETURNING *`,
        [company_id, soNumber, id, rfq.client_id, rfq.contract_id ?? null,
         rfq.quantity_mt, rfq.price_per_mt, total_value, rfq.currency]
      );
      createdOrder = soRows[0];
    }

    return { rfq: rows[0], sales_order: createdOrder };
  });

  // ── POST /api/sales-orders/rfqs/:id/cancel ───────────────────
  // RFQs have no money/stock impact — cancel is a status flip.
  // Refuse if the RFQ has already produced a confirmed sales order
  // (cancel that first).
  app.post('/rfqs/:id/cancel', {
    preHandler: [app.authenticate],
    schema: { body: { type: 'object', properties: { reason: { type: 'string' } } } },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;
    const reason = request.body?.reason ?? 'RFQ cancelled';
    try {
      const { rows: linkedSO } = await query(
        `SELECT id, status FROM sales_orders
          WHERE rfq_id = $1 AND company_id = $2
            AND COALESCE(status,'') NOT IN ('cancelled','reversed','draft')
          LIMIT 1`,
        [id, company_id]
      );
      if (linkedSO.length > 0) {
        throw new ReversalError(
          409,
          `Cannot cancel — sales order ${linkedSO[0].id.slice(0,8)} (${linkedSO[0].status}) was created from this RFQ. Cancel the sales order first.`,
          { blocking_sales_order_id: linkedSO[0].id }
        );
      }
      const result = await cancelDocument({
        table: 'rfqs',
        id,
        companyId: company_id,
        userId: user_id,
        reason,
        // RFQs have many in-flight statuses; allow cancel from any
        // non-terminal state.
        cancellableStatuses: [
          'draft', 'pending_factory', 'pending_logistics', 'pending_ceo',
          'approved', 'quotation_sent', 'pending_confirmation',
          'sent', 'expired',
        ],
      });
      return reply.status(200).send(result);
    } catch (err) { return sendReversalError(reply, err); }
  });

  // ── GET /api/sales-orders ─────────────────────────────────────
  app.get('/', { preHandler: [app.authenticate] }, async (request, _reply) => {
    const { company_id } = request.user;
    const { status, client_id, payment_status } = request.query;

    const conditions = ['so.company_id = $1'];
    const params = [company_id];
    let p = 2;
    if (status)         { conditions.push(`so.status         = $${p++}`); params.push(status); }
    if (client_id)      { conditions.push(`so.client_id      = $${p++}`); params.push(client_id); }
    if (payment_status) { conditions.push(`so.payment_status = $${p++}`); params.push(payment_status); }

    const { rows } = await query(
      `SELECT so.*,
              cl.name AS client_name, cl.country AS client_country,
              c.contract_number
       FROM sales_orders so
       LEFT JOIN clients cl ON cl.id = so.client_id
       LEFT JOIN contracts c ON c.id = so.contract_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY so.created_at DESC`,
      params
    );
    return { data: rows };
  });

  // ── GET /api/sales-orders/:id ─────────────────────────────────
  app.get('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;

    const { rows } = await query(
      `SELECT so.*,
              cl.name AS client_name, cl.country AS client_country,
              cl.payment_terms AS client_payment_terms,
              c.contract_number, c.payment_terms AS contract_payment_terms,
              c.payment_schedule_dates, c.payment_currency,
              r.rfq_number, r.product_description AS rfq_description
       FROM sales_orders so
       LEFT JOIN clients cl ON cl.id = so.client_id
       LEFT JOIN contracts c ON c.id = so.contract_id
       LEFT JOIN rfqs r ON r.id = so.rfq_id
       WHERE so.id = $1 AND so.company_id = $2`,
      [id, company_id]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Sales order not found' });
    return rows[0];
  });

  // ── PATCH /api/sales-orders/:id ──────────────────────────────
  app.patch('/:id', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          order_number:          { type: 'string' },
          quantity_mt:           { type: 'number' },
          price_per_mt:          { type: 'number' },
          currency:              { type: 'string' },
          bl_number:             { type: 'string' },
          bl_date:               { type: 'string' },
          vessel_name:           { type: 'string' },
          port_of_loading:       { type: 'string' },
          port_of_discharge:     { type: 'string' },
          eta:                   { type: 'string' },
          actual_arrival:        { type: 'string' },
          payment_due_date:      { type: 'string' },
          payment_received_date: { type: 'string' },
          payment_status:        { type: 'string' },
          status:                { type: 'string' },
          shipsgo_tracking_id:   { type: 'string' },
          production_order_id:   { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const body = request.body;

    const { rows: existing } = await query(
      `SELECT so.*, c.payment_terms, c.payment_schedule_dates
       FROM sales_orders so
       LEFT JOIN contracts c ON c.id = so.contract_id
       WHERE so.id = $1 AND so.company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) return reply.status(404).send({ error: 'Sales order not found' });

    const cur = existing[0];

    // Auto-calculate payment_due_date when actual_arrival or bl_date is set
    let payment_due_date = body.payment_due_date ?? null;
    const newArrival = body.actual_arrival ?? cur.actual_arrival;
    const newBlDate  = body.bl_date ?? cur.bl_date;

    if (!payment_due_date && (body.actual_arrival || body.bl_date)) {
      const contractInfo = cur.payment_terms ? {
        payment_terms:          cur.payment_terms,
        payment_schedule_dates: cur.payment_schedule_dates,
      } : null;
      payment_due_date = calcPaymentDueDate(contractInfo, newBlDate, newArrival);
    }

    const total_value = (body.price_per_mt && body.quantity_mt)
      ? body.price_per_mt * body.quantity_mt
      : (body.price_per_mt ? body.price_per_mt * parseFloat(cur.quantity_mt) : null);

    const { rows } = await query(
      `UPDATE sales_orders
       SET order_number          = COALESCE($3,  order_number),
           quantity_mt           = COALESCE($4,  quantity_mt),
           price_per_mt          = COALESCE($5,  price_per_mt),
           total_value           = COALESCE($6,  total_value),
           currency              = COALESCE($7,  currency),
           bl_number             = COALESCE($8,  bl_number),
           bl_date               = COALESCE($9,  bl_date),
           vessel_name           = COALESCE($10, vessel_name),
           port_of_loading       = COALESCE($11, port_of_loading),
           port_of_discharge     = COALESCE($12, port_of_discharge),
           eta                   = COALESCE($13, eta),
           actual_arrival        = COALESCE($14, actual_arrival),
           payment_due_date      = COALESCE($15, payment_due_date),
           payment_received_date = COALESCE($16, payment_received_date),
           payment_status        = COALESCE($17, payment_status),
           status                = COALESCE($18, status),
           shipsgo_tracking_id   = COALESCE($19, shipsgo_tracking_id),
           production_order_id   = COALESCE($20, production_order_id),
           updated_at            = now()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [id, company_id,
       body.order_number, body.quantity_mt, body.price_per_mt, total_value,
       body.currency, body.bl_number, body.bl_date, body.vessel_name,
       body.port_of_loading, body.port_of_discharge, body.eta,
       body.actual_arrival, payment_due_date, body.payment_received_date,
       body.payment_status, body.status, body.shipsgo_tracking_id,
       body.production_order_id]
    );
    return rows[0];
  });

  // ── POST /api/sales-orders/:id/cancel ────────────────────────
  // Cancel a draft sales order. No counter-entry — no impact existed.
  app.post('/:id/cancel', {
    preHandler: [app.authenticate],
    schema: { body: { type: 'object', properties: { reason: { type: 'string' } } } },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;
    const reason = request.body?.reason ?? 'Cancelled via sales';
    try {
      const result = await cancelDocument({
        table: 'sales_orders',
        id,
        companyId: company_id,
        userId: user_id,
        reason,
        // Only drafts can be cancelled. Confirmed and beyond have
        // already started moving inventory + invoices — those must
        // be reversed (which produces a real counter-trail) not
        // silently cancelled.
        cancellableStatuses: ['draft'],
      });
      return reply.status(200).send(result);
    } catch (err) { return sendReversalError(reply, err); }
  });

  // ── POST /api/sales-orders/:id/reverse ───────────────────────
  // Reverse a posted sales order. Cascade rules — refuse if any of
  // these downstream documents are still active:
  //   - linked invoice not yet cancelled / reversed
  //   - linked production_order still posted
  // Following NetSuite/SAP-style hard-block: user must reverse the
  // downstream doc first.
  app.post('/:id/reverse', {
    preHandler: [app.authenticate],
    schema: { body: { type: 'object', properties: { reason: { type: 'string' } } } },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;
    const reason = request.body?.reason ?? 'Sales order reversed';

    try {
      // Cascade pre-checks — done outside the helper so the caller
      // gets a clear, specific error message.
      const { rows: invoiceRows } = await query(
        `SELECT id, invoice_number, status FROM invoices
          WHERE sales_order_id = $1 AND company_id = $2
            AND status NOT IN ('cancelled','reversed')
          LIMIT 1`,
        [id, company_id]
      );
      if (invoiceRows.length > 0) {
        throw new ReversalError(
          409,
          `Cannot reverse — invoice ${invoiceRows[0].invoice_number ?? invoiceRows[0].id.slice(0,8)} is still '${invoiceRows[0].status}'. Reverse the invoice first.`,
          { blocking_invoice_id: invoiceRows[0].id }
        );
      }
      // sales_orders.production_order_id is the link side (no FK on
      // production_orders going back to sales_orders).
      const { rows: poRows } = await query(
        `SELECT po.id, po.po_number, po.status
           FROM production_orders po
           JOIN sales_orders so ON so.production_order_id = po.id
          WHERE so.id = $1 AND po.company_id = $2
            AND po.is_reversed = false
            AND COALESCE(po.status, '') NOT IN ('cancelled','reversed')
          LIMIT 1`,
        [id, company_id]
      );
      if (poRows.length > 0) {
        throw new ReversalError(
          409,
          `Cannot reverse — production order ${poRows[0].po_number ?? poRows[0].id.slice(0,8)} is still active. Reverse the production order first.`,
          { blocking_production_order_id: poRows[0].id }
        );
      }

      const result = await reverseDocument({
        table: 'sales_orders',
        id,
        companyId: company_id,
        userId: user_id,
        reason,
        extraStatus: { status: 'reversed' },
        // No counter-entry: sales_orders are top-level documents, not
        // line-level transactions. Reversing means stamping the row
        // terminal. No side effect either — money + stock impact lives
        // on the downstream invoice / production_order rows, which
        // must be reversed first (cascade check above).
      });
      return reply.status(200).send(result);
    } catch (err) { return sendReversalError(reply, err); }
  });
}
