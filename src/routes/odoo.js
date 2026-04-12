import { query } from '../db.js';

// ── Odoo JSON-RPC helper (XML-RPC compatible endpoint) ────────────
async function odooCall(url, service, method, args) {
  const res = await fetch(`${url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', id: 1,
      params: { service, method, args } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Odoo HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.data?.message ?? json.error.message ?? 'Odoo error');
  return json.result;
}

async function odooAuth(cfg) {
  const uid = await odooCall(cfg.odoo_url, 'common', 'authenticate',
    [cfg.odoo_db, cfg.odoo_user, cfg.odoo_api_key, {}]);
  if (!uid) throw new Error('Odoo authentication failed — check credentials');
  return uid;
}

async function odooExec(cfg, uid, model, method, args, kwargs = {}) {
  return odooCall(cfg.odoo_url, 'object', 'execute_kw',
    [cfg.odoo_db, uid, cfg.odoo_api_key, model, method, args, kwargs]);
}

async function getConfig(company_id) {
  const { rows } = await query(
    `SELECT * FROM odoo_config WHERE company_id=$1 AND is_active=true LIMIT 1`,
    [company_id]
  );
  if (!rows.length) throw new Error('Odoo not configured — add credentials in Settings');
  return rows[0];
}

export default async function odooRoutes(app) {

  // ── POST /api/odoo/config ─────────────────────────────────────
  app.post('/config', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, role } = request.user;
    if (role !== 'admin' && role !== 'ceo') return reply.status(403).send({ error: 'Admin required' });

    const { odoo_url, odoo_db, odoo_user, odoo_api_key } = request.body;
    if (!odoo_url || !odoo_db || !odoo_api_key) return reply.status(400).send({ error: 'odoo_url, odoo_db, odoo_api_key required' });

    await query(`DELETE FROM odoo_config WHERE company_id=$1`, [company_id]);
    const { rows } = await query(
      `INSERT INTO odoo_config (company_id, odoo_url, odoo_db, odoo_user, odoo_api_key)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, odoo_url, odoo_db, odoo_user, created_at`,
      [company_id, odoo_url.replace(/\/$/, ''), odoo_db, odoo_user ?? 'admin', odoo_api_key]
    );
    return rows[0];
  });

  // ── GET /api/odoo/config ──────────────────────────────────────
  app.get('/config', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT id, odoo_url, odoo_db, odoo_user, is_active, created_at, updated_at FROM odoo_config WHERE company_id=$1 LIMIT 1`,
      [company_id]
    );
    return rows[0] ?? null;
  });

  // ── POST /api/odoo/test-connection ────────────────────────────
  app.post('/test-connection', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    try {
      const cfg = await getConfig(company_id);
      const uid = await odooAuth(cfg);
      const version = await odooCall(cfg.odoo_url, 'common', 'version', []);
      return { ok: true, uid, odoo_version: version?.server_version ?? 'unknown', message: 'Connection successful' };
    } catch (err) {
      return reply.status(400).send({ ok: false, message: err.message });
    }
  });

  // ── POST /api/odoo/sync-client/:client_id ─────────────────────
  app.post('/sync-client/:client_id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { client_id } = request.params;

    const { rows: clientRows } = await query(
      `SELECT * FROM clients WHERE id=$1 AND company_id=$2`, [client_id, company_id]
    );
    if (!clientRows.length) return reply.status(404).send({ error: 'Client not found' });
    const client = clientRows[0];

    const cfg = await getConfig(company_id);
    const uid = await odooAuth(cfg);

    // Search for existing partner
    const existing = await odooExec(cfg, uid, 'res.partner', 'search',
      [[['name', 'ilike', client.name]]], { limit: 1 });

    let partner_id;
    if (existing && existing.length > 0) {
      partner_id = existing[0];
      await odooExec(cfg, uid, 'res.partner', 'write', [[partner_id], {
        name:    client.name,
        email:   client.contact_email ?? false,
        phone:   false,
        country_id: false,
        comment: `Netaj ERP client · ${client.client_code ?? ''}`,
      }]);
    } else {
      partner_id = await odooExec(cfg, uid, 'res.partner', 'create', [{
        name:    client.name,
        email:   client.contact_email ?? false,
        is_company: true,
        comment: `Netaj ERP client · ${client.client_code ?? ''}`,
      }]);
    }

    await query(
      `UPDATE clients SET odoo_partner_id=$1 WHERE id=$2`,
      [partner_id, client_id]
    );

    return { partner_id, synced: true };
  });

  // ── POST /api/odoo/create-invoice/:sales_order_id ─────────────
  app.post('/create-invoice/:sales_order_id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { sales_order_id } = request.params;

    // Load sales order with client
    const { rows: soRows } = await query(
      `SELECT so.*, c.name AS client_name, c.odoo_partner_id
       FROM sales_orders so
       JOIN clients c ON c.id = so.client_id
       WHERE so.id=$1 AND so.company_id=$2`,
      [sales_order_id, company_id]
    );
    if (!soRows.length) return reply.status(404).send({ error: 'Sales order not found' });
    const so = soRows[0];

    if (!so.odoo_partner_id) {
      return reply.status(400).send({ error: 'Sync client to Odoo first (POST /odoo/sync-client/:id)' });
    }

    // Load invoice items if available
    const { rows: items } = await query(
      `SELECT * FROM invoice_items WHERE invoice_id IN (
        SELECT id FROM invoices WHERE sales_order_id=$1 LIMIT 1
       )`,
      [sales_order_id]
    );

    const cfg = await getConfig(company_id);
    const uid = await odooAuth(cfg);

    // Build line items
    const invoiceLines = items.length > 0
      ? items.map(item => [0, 0, {
          name:        item.description,
          quantity:    item.quantity,
          price_unit:  item.unit_price,
        }])
      : [[0, 0, {
          name:       `Rubber Goods — SO ${so.order_number}`,
          quantity:   so.quantity_mt ?? 1,
          price_unit: so.price_per_mt ?? so.total_value ?? 0,
        }]];

    const invoiceId = await odooExec(cfg, uid, 'account.move', 'create', [{
      move_type:        'out_invoice',
      partner_id:       so.odoo_partner_id,
      invoice_date:     so.bl_date ?? new Date().toISOString().split('T')[0],
      ref:              so.order_number,
      narration:        so.bl_number ? `BL: ${so.bl_number}` : '',
      invoice_line_ids: invoiceLines,
    }]);

    // Read back the invoice number
    const [inv] = await odooExec(cfg, uid, 'account.move', 'read', [[invoiceId]], { fields: ['name', 'state'] });

    await query(
      `UPDATE sales_orders SET odoo_invoice_id=$1, odoo_invoice_number=$2,
       odoo_invoice_status=$3, odoo_synced_at=now() WHERE id=$4`,
      [invoiceId, inv.name, inv.state, sales_order_id]
    );

    return { odoo_invoice_id: invoiceId, odoo_invoice_number: inv.name, status: inv.state };
  });

  // ── POST /api/odoo/confirm-invoice/:sales_order_id ────────────
  app.post('/confirm-invoice/:sales_order_id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { sales_order_id } = request.params;

    const { rows: soRows } = await query(
      `SELECT odoo_invoice_id FROM sales_orders WHERE id=$1 AND company_id=$2`,
      [sales_order_id, company_id]
    );
    if (!soRows.length) return reply.status(404).send({ error: 'Not found' });
    if (!soRows[0].odoo_invoice_id) return reply.status(400).send({ error: 'Create invoice in Odoo first' });

    const invId = soRows[0].odoo_invoice_id;
    const cfg = await getConfig(company_id);
    const uid = await odooAuth(cfg);

    await odooExec(cfg, uid, 'account.move', 'action_post', [[invId]]);

    // Read updated status
    const [inv] = await odooExec(cfg, uid, 'account.move', 'read', [[invId]], { fields: ['name', 'state'] });

    await query(
      `UPDATE sales_orders SET odoo_invoice_status=$1, odoo_synced_at=now(),
       status=CASE WHEN status='shipped' THEN 'invoiced' ELSE status END
       WHERE id=$2`,
      [inv.state, sales_order_id]
    );

    return { status: inv.state, confirmed: true };
  });

  // ── GET /api/odoo/invoice-status/:sales_order_id ──────────────
  app.get('/invoice-status/:sales_order_id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { sales_order_id } = request.params;

    const { rows: soRows } = await query(
      `SELECT odoo_invoice_id, odoo_invoice_number, odoo_invoice_status, odoo_synced_at
       FROM sales_orders WHERE id=$1 AND company_id=$2`,
      [sales_order_id, company_id]
    );
    if (!soRows.length) return reply.status(404).send({ error: 'Not found' });
    const so = soRows[0];
    if (!so.odoo_invoice_id) return { synced: false };

    const cfg = await getConfig(company_id);
    const uid = await odooAuth(cfg);

    const [inv] = await odooExec(cfg, uid, 'account.move', 'read', [[so.odoo_invoice_id]],
      { fields: ['name', 'state', 'payment_state', 'amount_total'] });

    const newStatus = inv.state === 'posted' && inv.payment_state === 'paid' ? 'paid' : inv.state;

    await query(
      `UPDATE sales_orders SET odoo_invoice_status=$1, odoo_synced_at=now()
       ${newStatus === 'paid' ? ", payment_status='paid'" : ''}
       WHERE id=$2`,
      [newStatus, sales_order_id]
    );

    return { synced: true, odoo_invoice_id: so.odoo_invoice_id, odoo_invoice_number: inv.name,
      state: inv.state, payment_state: inv.payment_state, amount_total: inv.amount_total, odoo_status: newStatus };
  });

  // ── GET /api/odoo/invoice-pdf/:sales_order_id ─────────────────
  app.get('/invoice-pdf/:sales_order_id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { sales_order_id } = request.params;

    const { rows: soRows } = await query(
      `SELECT odoo_invoice_id FROM sales_orders WHERE id=$1 AND company_id=$2`,
      [sales_order_id, company_id]
    );
    if (!soRows.length) return reply.status(404).send({ error: 'Not found' });
    if (!soRows[0].odoo_invoice_id) return reply.status(400).send({ error: 'No Odoo invoice linked' });

    const invId = soRows[0].odoo_invoice_id;
    const cfg = await getConfig(company_id);

    // Authenticate to get session
    const sessionRes = await fetch(`${cfg.odoo_url}/web/session/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {
        db: cfg.odoo_db, login: cfg.odoo_user, password: cfg.odoo_api_key
      }}),
    });
    const sessionJson = await sessionRes.json();
    const cookie = sessionRes.headers.get('set-cookie') ?? '';

    // Download PDF
    const pdfRes = await fetch(
      `${cfg.odoo_url}/report/pdf/account.report_invoice/${invId}`,
      { headers: { Cookie: cookie } }
    );
    if (!pdfRes.ok) return reply.status(502).send({ error: 'Failed to fetch PDF from Odoo' });

    const buffer = await pdfRes.arrayBuffer();
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="odoo-invoice-${invId}.pdf"`);
    return reply.send(Buffer.from(buffer));
  });
}
