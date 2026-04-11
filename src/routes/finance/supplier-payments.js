import { pool, withTransaction, logAudit } from '../../db.js';

export default async function supplierPaymentsRoutes(app) {

  // ── GET /api/finance/supplier-payments ───────────────────────
  app.get('/supplier-payments', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          supplier_id: { type: 'string' },
          status:      { type: 'string' },
          limit:       { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset:      { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, _reply) => {
    const { company_id } = request.user;
    const { supplier_id, status, limit, offset } = request.query;

    const conditions = ['spl.company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (supplier_id) { conditions.push(`spl.supplier_id = $${p++}`); params.push(supplier_id); }
    if (status)      { conditions.push(`spl.status = $${p++}`);      params.push(status); }

    params.push(limit, offset);

    const { rows } = await pool.query(
      `SELECT spl.*,
              s.name AS supplier_name,
              ba.bank_name, ba.account_name
       FROM supplier_payment_ledger spl
       LEFT JOIN suppliers s ON s.id = spl.supplier_id
       LEFT JOIN bank_accounts ba ON ba.id = spl.bank_account_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY spl.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS total FROM supplier_payment_ledger spl WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2)
    );

    return { data: rows, total: parseInt(countRows[0].total, 10), limit, offset };
  });

  // ── POST /api/finance/supplier-payments ──────────────────────
  app.post('/supplier-payments', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['supplier_id', 'amount'],
        properties: {
          supplier_id:     { type: 'string' },
          bank_account_id: { type: 'string' },
          amount:          { type: 'number', minimum: 0.01 },
          payment_date:    { type: 'string' },
          reference:       { type: 'string' },
          invoice_url:     { type: 'string' },
          notes:           { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { supplier_id, bank_account_id, amount, payment_date, reference, invoice_url, notes } = request.body;

    // Verify supplier
    const { rows: supRows } = await pool.query(
      `SELECT id FROM suppliers WHERE id = $1 AND company_id = $2`,
      [supplier_id, company_id]
    );
    if (supRows.length === 0) return reply.status(404).send({ error: 'Supplier not found' });

    const { rows } = await pool.query(
      `INSERT INTO supplier_payment_ledger
         (company_id, supplier_id, bank_account_id, amount, payment_date,
          reference, invoice_url, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [company_id, supplier_id, bank_account_id ?? null, amount,
       payment_date ?? null, reference ?? null, invoice_url ?? null,
       notes ?? null, user_id]
    );

    await logAudit({ companyId: company_id, userId: user_id, action: 'create',
      entityType: 'supplier_payment', entityId: rows[0].id, newValues: rows[0] });

    return reply.status(201).send(rows[0]);
  });

  // ── PATCH /api/finance/supplier-payments/:id/approve ─────────
  app.patch('/supplier-payments/:id/approve', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;

    const { rows: existing } = await pool.query(
      `SELECT * FROM supplier_payment_ledger WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) return reply.status(404).send({ error: 'Payment not found' });
    if (existing[0].status !== 'pending') {
      return reply.status(409).send({ error: `Cannot approve — current status is '${existing[0].status}'` });
    }

    const { rows } = await pool.query(
      `UPDATE supplier_payment_ledger
       SET status = 'approved', approved_by = $1, approved_at = now()
       WHERE id = $2 AND company_id = $3
       RETURNING *`,
      [user_id, id, company_id]
    );

    await logAudit({ companyId: company_id, userId: user_id, action: 'approve',
      entityType: 'supplier_payment', entityId: id,
      oldValues: { status: 'pending' }, newValues: { status: 'approved' } });

    return rows[0];
  });

  // ── PATCH /api/finance/supplier-payments/:id/reject ──────────
  app.patch('/supplier-payments/:id/reject', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;
    const reason = request.body?.reason ?? null;

    const { rows: existing } = await pool.query(
      `SELECT * FROM supplier_payment_ledger WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) return reply.status(404).send({ error: 'Payment not found' });

    const { rows } = await pool.query(
      `UPDATE supplier_payment_ledger
       SET status = 'rejected', approved_by = $1, approved_at = now(), notes = COALESCE($2, notes)
       WHERE id = $3 AND company_id = $4
       RETURNING *`,
      [user_id, reason, id, company_id]
    );

    await logAudit({ companyId: company_id, userId: user_id, action: 'reject',
      entityType: 'supplier_payment', entityId: id,
      oldValues: { status: existing[0].status }, newValues: { status: 'rejected' }, reason });

    return rows[0];
  });
}
