import { query } from '../../db.js';
import { reverseDocument, cancelDocument, sendReversalError, ReversalError } from '../../services/reversal.js';

export default async function ordersRoutes(app) {

  // ── GET /api/production/orders ────────────────────────────────
  app.get('/orders', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status:    { type: 'string' },
          client_id: { type: 'string' },
          limit:     { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset:    { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { status, client_id, limit, offset } = request.query;

    const conditions = ['o.company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (status) {
      conditions.push(`o.status = $${p++}`);
      params.push(status);
    }
    if (client_id) {
      conditions.push(`o.client_id = $${p++}`);
      params.push(client_id);
    }

    params.push(limit, offset);

    const { rows } = await query(
      `SELECT o.id, o.po_number, o.material, o.quantity, o.unit,
              o.price_per_mt_usd, o.usd_to_sar_rate, o.status, o.notes,
              o.created_at, o.created_by, o.etd,
              o.invoice_status, o.payment_received,
              o.invoice_sent_at, o.expected_payment_date,
              o.expected_production_date, o.expected_invoicing_date,
              o.container_loading_date,
              o.is_partial_shipment, o.total_shipments, o.priority_order,
              o.transport_status, o.ships_go_tracking_active, o.ready_for_invoice,
              o.vessel_name, o.bl_number, o.port_of_loading, o.port_of_discharge,
              ROUND((o.price_per_mt_usd * o.quantity)::numeric, 2)                    AS total_value_usd,
              ROUND((o.price_per_mt_usd * o.quantity * o.usd_to_sar_rate)::numeric, 2) AS total_value_sar,
              c.name AS client_name
       FROM production_orders o
       LEFT JOIN clients c ON c.id = o.client_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY o.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    // params ends with [limit, offset] — slice those off for the count query
    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS total FROM production_orders o
       WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2)
    );

    return {
      data:   rows,
      total:  parseInt(countRows[0].total, 10),
      limit,
      offset,
    };
  });

  // ── POST /api/production/orders ───────────────────────────────
  app.post('/orders', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['po_number'],
        properties: {
          po_number:        { type: 'string', minLength: 1 },
          client_id:        { type: 'string' },
          material:         { type: 'string' },
          quantity:         { type: 'number', minimum: 0 },
          unit:             { type: 'string', default: 'MT' },
          price_per_mt_usd: { type: 'number', minimum: 0 },
          usd_to_sar_rate:  { type: 'number', minimum: 0, default: 3.75 },
          notes:            { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: created_by } = request.user;
    const {
      po_number, client_id, material, quantity,
      unit = 'MT', price_per_mt_usd, usd_to_sar_rate = 3.75, notes,
    } = request.body;

    // Duplicate PO number check
    const { rows: existing } = await query(
      `SELECT id FROM production_orders WHERE company_id = $1 AND po_number = $2`,
      [company_id, po_number.trim()]
    );
    if (existing.length > 0) {
      return reply.status(409).send({ error: `PO number '${po_number}' already exists` });
    }

    const { rows } = await query(
      `INSERT INTO production_orders
         (company_id, po_number, client_id, material, quantity, unit,
          price_per_mt_usd, usd_to_sar_rate, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        company_id, po_number.trim(), client_id ?? null, material ?? null,
        quantity ?? null, unit, price_per_mt_usd ?? null,
        usd_to_sar_rate, notes ?? null, created_by,
      ]
    );

    return reply.status(201).send(rows[0]);
  });

  // ── GET /api/production/orders/:id ───────────────────────────
  app.get('/orders/:id', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;

    const { rows } = await query(
      `SELECT o.*, c.name AS client_name
       FROM production_orders o
       LEFT JOIN clients c ON c.id = o.client_id
       WHERE o.id = $1 AND o.company_id = $2`,
      [id, company_id]
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Production order not found' });
    }

    return rows[0];
  });

  // ── PATCH /api/production/orders/:id ─────────────────────────
  // Updates mutable fields: status, transport_status, vessel_name,
  // bl_number, etd, is_partial_shipment, total_shipments,
  // priority_order, client_name, notes.
  app.patch('/orders/:id', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          status:              { type: 'string' },
          transport_status:    { type: 'string' },
          vessel_name:         { type: 'string' },
          bl_number:           { type: 'string' },
          etd:                 { type: 'string' },
          is_partial_shipment: { type: 'boolean' },
          total_shipments:     { type: 'integer', minimum: 1 },
          priority_order:      { type: 'integer' },
          client_name:            { type: 'string' },
          notes:                  { type: 'string' },
          // Invoice fields
          invoice_status:         { type: 'string' },
          invoice_number:         { type: 'string' },
          invoice_url:            { type: 'string' },
          invoice_uploaded:       { type: 'boolean' },
          invoice_uploaded_at:    { type: 'string' },
          invoice_sent_to_client: { type: 'boolean' },
          invoice_sent_at:        { type: 'string' },
          payment_terms:          { type: 'string' },
          expected_payment_date:  { type: 'string' },
          actual_payment_date:    { type: 'string' },
          payment_received:       { type: 'boolean' },
          client_remittance_url:  { type: 'string' },
          final_bl_uploaded:      { type: 'boolean' },
          container_loading_date:      { type: 'string' },
          expected_production_date:    { type: 'string' },
          expected_invoicing_date:     { type: 'string' },
          // Logistics fields
          booking_date:                { type: 'string' },
          port_of_loading:             { type: 'string' },
          port_of_discharge:           { type: 'string' },
          bl_copy_sent_to_client:      { type: 'boolean' },
          bl_client_status:            { type: 'string' },
          bl_amendment_notes:          { type: 'string' },
          llp_po_generated:            { type: 'boolean' },
          llp_invoice_uploaded:        { type: 'boolean' },
          llp_invoice_url:             { type: 'string' },
          customs_documents_uploaded:  { type: 'boolean' },
          customs_documents_url:       { type: 'string' },
          ships_go_tracking_active:    { type: 'boolean' },
          ready_for_invoice:           { type: 'boolean' },
          ups_airway_bill_number:      { type: 'string' },
          priority:                    { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const {
      status, transport_status, vessel_name, bl_number, etd,
      is_partial_shipment, total_shipments, priority_order, client_name, notes,
      invoice_status, invoice_number, invoice_url, invoice_uploaded, invoice_uploaded_at,
      invoice_sent_to_client, invoice_sent_at, payment_terms, expected_payment_date,
      actual_payment_date, payment_received, client_remittance_url,
      final_bl_uploaded, container_loading_date,
      expected_production_date, expected_invoicing_date,
      booking_date, port_of_loading, port_of_discharge,
      bl_copy_sent_to_client, bl_client_status, bl_amendment_notes,
      llp_po_generated, llp_invoice_uploaded, llp_invoice_url,
      customs_documents_uploaded, customs_documents_url, ships_go_tracking_active,
      ready_for_invoice, ups_airway_bill_number, priority,
    } = request.body;

    const { rows: existing } = await query(
      `SELECT id FROM production_orders WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) {
      return reply.status(404).send({ error: 'Production order not found' });
    }

    const sets = ['updated_at = now()'];
    const params = [id, company_id];
    let p = 3;

    if (status              !== undefined) { sets.push(`status = $${p++}`);              params.push(status); }
    if (transport_status    !== undefined) { sets.push(`transport_status = $${p++}`);    params.push(transport_status); }
    if (vessel_name         !== undefined) { sets.push(`vessel_name = $${p++}`);         params.push(vessel_name); }
    if (bl_number           !== undefined) { sets.push(`bl_number = $${p++}`);           params.push(bl_number); }
    if (etd                 !== undefined) { sets.push(`etd = $${p++}`);                 params.push(etd); }
    if (is_partial_shipment !== undefined) { sets.push(`is_partial_shipment = $${p++}`); params.push(is_partial_shipment); }
    if (total_shipments     !== undefined) { sets.push(`total_shipments = $${p++}`);     params.push(total_shipments); }
    if (priority_order      !== undefined) { sets.push(`priority_order = $${p++}`);      params.push(priority_order); }
    if (client_name             !== undefined) { sets.push(`client_name = $${p++}`);             params.push(client_name); }
    if (notes                   !== undefined) { sets.push(`notes = $${p++}`);                   params.push(notes); }
    if (invoice_status          !== undefined) { sets.push(`invoice_status = $${p++}`);          params.push(invoice_status); }
    if (invoice_number          !== undefined) { sets.push(`invoice_number = $${p++}`);          params.push(invoice_number); }
    if (invoice_url             !== undefined) { sets.push(`invoice_url = $${p++}`);             params.push(invoice_url); }
    if (invoice_uploaded        !== undefined) { sets.push(`invoice_uploaded = $${p++}`);        params.push(invoice_uploaded); }
    if (invoice_uploaded_at     !== undefined) { sets.push(`invoice_uploaded_at = $${p++}`);     params.push(invoice_uploaded_at); }
    if (invoice_sent_to_client  !== undefined) { sets.push(`invoice_sent_to_client = $${p++}`);  params.push(invoice_sent_to_client); }
    if (invoice_sent_at         !== undefined) { sets.push(`invoice_sent_at = $${p++}`);         params.push(invoice_sent_at); }
    if (payment_terms           !== undefined) { sets.push(`payment_terms = $${p++}`);           params.push(payment_terms); }
    if (expected_payment_date   !== undefined) { sets.push(`expected_payment_date = $${p++}`);   params.push(expected_payment_date); }
    if (actual_payment_date     !== undefined) { sets.push(`actual_payment_date = $${p++}`);     params.push(actual_payment_date); }
    if (payment_received        !== undefined) { sets.push(`payment_received = $${p++}`);        params.push(payment_received); }
    if (client_remittance_url   !== undefined) { sets.push(`client_remittance_url = $${p++}`);   params.push(client_remittance_url); }
    if (final_bl_uploaded       !== undefined) { sets.push(`final_bl_uploaded = $${p++}`);       params.push(final_bl_uploaded); }
    if (container_loading_date   !== undefined) { sets.push(`container_loading_date = $${p++}`);    params.push(container_loading_date); }
    if (expected_production_date !== undefined) { sets.push(`expected_production_date = $${p++}`);  params.push(expected_production_date); }
    if (expected_invoicing_date  !== undefined) { sets.push(`expected_invoicing_date = $${p++}`);   params.push(expected_invoicing_date); }

    const { rows } = await query(
      `UPDATE production_orders
       SET ${sets.join(', ')}
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      params
    );

    return rows[0];
  });

  // ── POST /api/production/orders/:id/cancel ───────────────────
  // Cancel a production order before any batch has been posted.
  app.post('/orders/:id/cancel', {
    preHandler: [app.authenticate],
    schema: { body: { type: 'object', properties: { reason: { type: 'string' } } } },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;
    const reason = request.body?.reason ?? 'Cancelled before production';

    try {
      // Cascade pre-check: refuse if any batch already posted.
      const { rows: batchRows } = await query(
        `SELECT id FROM production_batches
          WHERE production_order_id = $1 AND company_id = $2
            AND COALESCE(status,'') NOT IN ('cancelled','reversed')
            AND is_reversed = false
          LIMIT 1`,
        [id, company_id]
      );
      if (batchRows.length > 0) {
        throw new ReversalError(
          409,
          `Cannot cancel — production has already started (batch posted). Reverse the batches first, then reverse the order.`,
          { blocking_batch_id: batchRows[0].id }
        );
      }
      const result = await cancelDocument({
        table: 'production_orders',
        id,
        companyId: company_id,
        userId: user_id,
        reason,
        // Production orders typically don't have a 'submitted' middle
        // step — they go straight from received to in_production.
        cancellableStatuses: ['received', 'pending', 'draft'],
      });
      return reply.status(200).send(result);
    } catch (err) { return sendReversalError(reply, err); }
  });

  // ── POST /api/production/orders/:id/reverse ──────────────────
  // Reverse a production order. Hard cascade: every batch attached
  // must already be reversed; otherwise inventory state is inconsistent.
  app.post('/orders/:id/reverse', {
    preHandler: [app.authenticate],
    schema: { body: { type: 'object', properties: { reason: { type: 'string' } } } },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;
    const reason = request.body?.reason ?? 'Production order reversed';

    try {
      const { rows: liveBatches } = await query(
        `SELECT id, status FROM production_batches
          WHERE production_order_id = $1 AND company_id = $2
            AND is_reversed = false
            AND COALESCE(status,'') NOT IN ('cancelled','reversed')
          LIMIT 1`,
        [id, company_id]
      );
      if (liveBatches.length > 0) {
        throw new ReversalError(
          409,
          `Cannot reverse — batch ${liveBatches[0].id.slice(0,8)} is still active. Reverse it first.`,
          { blocking_batch_id: liveBatches[0].id }
        );
      }
      const result = await reverseDocument({
        table: 'production_orders',
        id,
        companyId: company_id,
        userId: user_id,
        reason,
        extraStatus: { status: 'reversed' },
        // Top-level doc; no counter-entry. The inventory side-effect
        // was already undone batch-by-batch.
      });
      return reply.status(200).send(result);
    } catch (err) { return sendReversalError(reply, err); }
  });
}
