import { queueEmail, emailTemplate } from '../../services/email.js';
import { query, pool, withTransaction, logAudit } from '../../db.js';

export default async function fundsRoutes(app) {

  // ── GET /api/finance/accounts ─────────────────────────────────
  app.get('/accounts', {
    preHandler: [app.authenticate],
  }, async (request, _reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT id, account_type, account_name, currency, current_balance, created_at
       FROM fund_accounts
       WHERE company_id = $1
       ORDER BY account_name ASC`,
      [company_id]
    );
    return { data: rows };
  });

  // ── POST /api/finance/accounts ────────────────────────────────
  app.post('/accounts', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['account_name', 'account_type'],
        properties: {
          account_name:    { type: 'string', minLength: 1 },
          account_type:    { type: 'string', enum: ['petty_cash', 'bank', 'corporate_card', 'raw_materials'] },
          current_balance: { type: 'number', default: 0 },
          currency:        { type: 'string', default: 'SAR' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { account_name, account_type, current_balance = 0, currency = 'SAR' } = request.body;
    const { rows } = await query(
      `INSERT INTO fund_accounts (company_id, account_name, account_type, current_balance, currency)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [company_id, account_name.trim(), account_type, current_balance, currency]
    );
    return reply.status(201).send(rows[0]);
  });

  // ── GET /api/finance/requests ─────────────────────────────────
  app.get('/requests', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status:       { type: 'string' },
          statuses:     { type: 'string' }, // comma-separated list of statuses
          request_type: { type: 'string' },
          requested_by: { type: 'string' },
          from:         { type: 'string' },
          to:           { type: 'string' },
          limit:        { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset:       { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, _reply) => {
    const { company_id } = request.user;
    const { status, statuses, request_type, requested_by, from, to, limit, offset } = request.query;

    const conditions = ['r.company_id = $1', 'r.deleted_at IS NULL'];
    const params = [company_id];
    let p = 2;

    if (statuses) {
      const list = statuses.split(',').map(s => s.trim()).filter(Boolean);
      if (list.length === 1) {
        conditions.push(`r.status = $${p++}`); params.push(list[0]);
      } else if (list.length > 1) {
        conditions.push(`r.status = ANY($${p++}::text[])`); params.push(list);
      }
    } else if (status) {
      conditions.push(`r.status = $${p++}`); params.push(status);
    }
    if (request_type) { conditions.push(`r.request_type = $${p++}`); params.push(request_type); }
    if (requested_by) { conditions.push(`r.requested_by = $${p++}`); params.push(requested_by); }
    if (from)         { conditions.push(`r.created_at  >= $${p++}`); params.push(from); }
    if (to)           { conditions.push(`r.created_at  <= $${p++}`); params.push(to); }

    params.push(limit, offset);

    const { rows } = await query(
      `SELECT r.*,
              u.full_name AS requester_name, u.email AS requester_email,
              c.card_name, c.last_four,
              ec.name AS category_name,
              s.name AS supplier_name,
              eba.employee_name AS emp_bank_employee_name,
              eba.bank_name     AS emp_bank_name,
              eba.account_number AS emp_bank_account_number,
              eba.iban          AS emp_bank_iban
       FROM fund_requests r
       LEFT JOIN users u ON u.id = r.requested_by
       LEFT JOIN corporate_cards c ON c.id = r.card_id
       LEFT JOIN expense_categories ec ON ec.id = r.category_id
       LEFT JOIN suppliers s ON s.id = r.supplier_id
       LEFT JOIN bank_accounts ba ON ba.id = r.bank_account_id
       LEFT JOIN employee_bank_accounts eba ON eba.id = r.employee_bank_account_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY r.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS total FROM fund_requests r WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2)
    );

    return { data: rows, total: parseInt(countRows[0].total, 10), limit, offset };
  });

  // ── GET /api/finance/requests/:id ────────────────────────────
  app.get('/requests/:id', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { rows } = await query(
      `SELECT r.*,
              u.full_name AS requester_name, u.email AS requester_email,
              c.card_name, c.last_four,
              ec.name AS category_name,
              s.name AS supplier_name,
              ba.bank_name, ba.account_name AS bank_account_name,
              eba.employee_name AS emp_bank_employee_name,
              eba.bank_name     AS emp_bank_name,
              eba.account_number AS emp_bank_account_number,
              eba.iban          AS emp_bank_iban
       FROM fund_requests r
       LEFT JOIN users u ON u.id = r.requested_by
       LEFT JOIN corporate_cards c ON c.id = r.card_id
       LEFT JOIN expense_categories ec ON ec.id = r.category_id
       LEFT JOIN suppliers s ON s.id = r.supplier_id
       LEFT JOIN bank_accounts ba ON ba.id = r.bank_account_id
       LEFT JOIN employee_bank_accounts eba ON eba.id = r.employee_bank_account_id
       WHERE r.id = $1 AND r.company_id = $2`,
      [id, company_id]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Fund request not found' });
    return rows[0];
  });

  // ── POST /api/finance/requests ────────────────────────────────
  app.post('/requests', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['amount', 'purpose'],
        properties: {
          amount:         { type: 'number', exclusiveMinimum: 0 },
          purpose:        { type: 'string', minLength: 1 },
          purpose_id:     { type: 'string' },
          purpose_other:  { type: 'string' },
          request_type:   { type: 'string', default: 'general' },
          payment_method: { type: 'string' },
          card_id:        { type: 'string' },
          category_id:    { type: 'string' },
          supplier_id:    { type: 'string' },
          vendor_name:    { type: 'string' },
          notes:          { type: 'string' },
          document_url:   { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: requested_by, id: req_user_id } = request.user;
    const {
      amount, purpose, purpose_id, purpose_other, request_type = 'general', payment_method,
      card_id, category_id, supplier_id, vendor_name, notes, document_url,
    } = request.body;
    const resolvedBy = requested_by ?? req_user_id;

    const { rows } = await query(
      `INSERT INTO fund_requests
         (company_id, requested_by, amount, purpose, purpose_id, purpose_other,
          request_type, payment_method, card_id, category_id, supplier_id, vendor_name, notes, document_url, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'submitted')
       RETURNING *`,
      [company_id, resolvedBy, amount, purpose.trim(),
       purpose_id ?? null, purpose_other ?? null,
       request_type, payment_method ?? null, card_id ?? null,
       category_id ?? null, supplier_id ?? null, vendor_name ?? null, notes ?? null, document_url ?? null]
    );

    await logAudit({ companyId: company_id, userId: resolvedBy, action: 'create',
      entityType: 'fund_request', entityId: rows[0].id, newValues: rows[0] });

    return reply.status(201).send(rows[0]);
  });

  // ── PATCH /api/finance/requests/:id/manager-approve ──────────
  app.patch('/requests/:id/manager-approve', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;

    const { rows: existing } = await query(
      `SELECT id, status, amount FROM fund_requests WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) return reply.status(404).send({ error: 'Fund request not found' });
    if (existing[0].status !== 'submitted') {
      return reply.status(409).send({ error: `Cannot manager-approve — status is '${existing[0].status}'` });
    }

    const { rows } = await query(
      `UPDATE fund_requests
       SET status = 'manager_approved',
           manager_approved_by = $1, manager_approved_at = now(), updated_at = now()
       WHERE id = $2 AND company_id = $3
       RETURNING *`,
      [user_id, id, company_id]
    );

    await logAudit({ companyId: company_id, userId: user_id, action: 'manager_approve',
      entityType: 'fund_request', entityId: id,
      oldValues: { status: 'submitted' }, newValues: { status: 'manager_approved' } });

    return rows[0];
  });

  // ── PATCH /api/finance/requests/:id/approve ───────────────────
  // Full (admin/CEO) approval — optionally debits a fund account
  app.patch('/requests/:id/approve', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          approved_amount: { type: 'number', exclusiveMinimum: 0 },
          account_id:      { type: 'string' }, // fund account to debit (optional)
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;
    const { approved_amount: requestedAmount, account_id } = request.body ?? {};

    const { rows: existing } = await query(
      `SELECT * FROM fund_requests WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) return reply.status(404).send({ error: 'Fund request not found' });

    const req = existing[0];
    const approvedAmount = requestedAmount ?? req.amount;

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE fund_requests
         SET status = 'approved', approved_amount = $1,
             admin_approved_by = $2, admin_approved_at = now(), updated_at = now()
         WHERE id = $3 AND company_id = $4
         RETURNING *`,
        [approvedAmount, user_id, id, company_id]
      );

      // Optionally log a fund account commitment (informational — no balance change yet)
      if (account_id) {
        const { rows: acctRows } = await client.query(
          `SELECT id FROM fund_accounts WHERE id = $1 AND company_id = $2`,
          [account_id, company_id]
        );
        if (acctRows.length > 0) {
          await client.query(
            `UPDATE fund_requests SET bank_account_id = $1 WHERE id = $2`,
            [account_id, id]
          );
        }
      }

      return rows[0];
    });

    await logAudit({ companyId: company_id, userId: user_id, action: 'approve',
      entityType: 'fund_request', entityId: id,
      oldValues: { status: req.status }, newValues: { status: 'approved', approved_amount: approvedAmount } });


    // Email notification — fund request approved
    try {
      const { rows: requesterRows } = await query(
        `SELECT u.email, u.full_name, fr.title, fr.amount FROM fund_requests fr
          JOIN users u ON u.id = fr.requested_by
          WHERE fr.id = $1`,
        [id]
      );
      if (requesterRows.length) {
        const r = requesterRows[0];
        await queueEmail({
          company_id,
          to: r.email,
          subject: 'Fund Request Approved — ' + (r.title ?? 'Your request'),
          body_html: emailTemplate('Fund Request Approved',
            `<p>Hi ${r.full_name ?? 'there'},</p>
            <p>Your fund request <strong>${r.title ?? ''}</strong> for
            <strong>SAR ${Number(approvedAmount).toLocaleString()}</strong>
            has been <span class=green>Approved</span>.</p>
            <p>Log in at <a href=https://netaj.co>netaj.co</a> to view details.</p>`),
          transaction_id: id, transaction_type: 'fund_request',
        });
      }
    } catch (_e) {}

    return result;
  });

  // ── PATCH /api/finance/requests/:id/reject ────────────────────
  app.patch('/requests/:id/reject', {
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

    const { rows: existing } = await query(
      `SELECT id, status FROM fund_requests WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) return reply.status(404).send({ error: 'Fund request not found' });

    const { rows } = await query(
      `UPDATE fund_requests
       SET status = 'rejected', rejection_reason = $1,
           admin_approved_by = $2, admin_approved_at = now(), updated_at = now()
       WHERE id = $3 AND company_id = $4
       RETURNING *`,
      [reason, user_id, id, company_id]
    );

    await logAudit({ companyId: company_id, userId: user_id, action: 'reject',
      entityType: 'fund_request', entityId: id,
      oldValues: { status: existing[0].status }, newValues: { status: 'rejected' }, reason });


    // Email notification — fund request rejected
    try {
      const { rows: requesterRows } = await query(
        `SELECT u.email, u.full_name, fr.title FROM fund_requests fr
          JOIN users u ON u.id = fr.requested_by
          WHERE fr.id = `, [id]
      );
      if (requesterRows.length) {
        const r = requesterRows[0];
        await queueEmail({
          company_id,
          to: r.email,
          subject: 'Fund Request Rejected — ' + (r.title ?? 'Your request'),
          body_html: emailTemplate('Fund Request Rejected',
            `<p>Hi ${r.full_name ?? 'there'},</p>
            <p>Your fund request <strong>${r.title ?? ''}</strong> has been <span class=red>Rejected</span>.${reason ? '<br>Reason: ' + reason : ''}</p>
            <p>Log in at <a href=https://netaj.co>netaj.co</a> for details.</p>`),
          transaction_id: id, transaction_type: 'fund_request',
        });
      }
    } catch (_e) {}

    return rows[0];
  });

  // ── PATCH /api/finance/requests/:id/issue ────────────────────
  // Mark funds as issued — debit the fund account
  app.patch('/requests/:id/issue', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          amount_issued:  { type: 'number', exclusiveMinimum: 0 },
          payment_method: { type: 'string' },
          check_number:   { type: 'string' },
          payment_details: {},
          account_id:     { type: 'string' },
          card_id:        { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;
    const {
      amount_issued, payment_method, check_number, payment_details,
      account_id, card_id,
    } = request.body ?? {};

    const { rows: existing } = await query(
      `SELECT * FROM fund_requests WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) return reply.status(404).send({ error: 'Fund request not found' });

    const req = existing[0];
    const issuedAmt = amount_issued ?? req.approved_amount ?? req.amount;
    const alreadyIssued = req.amount_issued ?? 0;
    const totalIssued = alreadyIssued + issuedAmt;
    const totalApproved = req.approved_amount ?? req.amount;
    const remaining = totalApproved - totalIssued;
    const newStatus = remaining <= 0.001 ? 'funds_issued' : 'partially_issued';

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE fund_requests
         SET status = $1, amount_issued = $2, remaining_amount = $3,
             payment_method = COALESCE($4, payment_method),
             check_number   = COALESCE($5, check_number),
             payment_details = COALESCE($6, payment_details),
             card_id        = COALESCE($7, card_id),
             issued_at      = COALESCE(issued_at, now()),
             updated_at     = now()
         WHERE id = $8 AND company_id = $9
         RETURNING *`,
        [newStatus, totalIssued, Math.max(0, remaining),
         payment_method ?? null, check_number ?? null,
         payment_details ? JSON.stringify(payment_details) : null,
         card_id ?? null, id, company_id]
      );

      // Route to correct wallet based on request type
      // Vendor/direct payments are bank transfers — no factory wallet change
      const requestType     = req.request_type ?? 'general';
      const isVendorPayment = ['vendor_payment', 'direct_vendor_payment'].includes(requestType);
      const walletType      = requestType === 'raw_material_cash' ? 'raw_materials' : 'petty_cash';

      if (!isVendorPayment) {
        // ALWAYS look up wallet by request_type — never trust account_id from the body
        // (account_id may point to a card or bank account, not a factory wallet)
        let walletAccountId = null;
        {
          const { rows: acctRows } = await client.query(
            `SELECT id FROM fund_accounts WHERE company_id = $1 AND account_type = $2 LIMIT 1`,
            [company_id, walletType]
          );
          if (acctRows.length > 0) walletAccountId = acctRows[0].id;
        }
        if (walletAccountId) {
          // Inflow: cash physically arrives at the factory wallet
          await client.query(
            `UPDATE fund_accounts SET current_balance = current_balance + $1 WHERE id = $2 AND company_id = $3`,
            [issuedAmt, walletAccountId, company_id]
          );
          await client.query(
            `INSERT INTO fund_transactions
               (company_id, account_id, transaction_type, amount, description,
                category, reference_id, reference_type, created_by, wallet_type)
             VALUES ($1,$2,'inflow',$3,$4,'fund_request_issuance',$5,'fund_request',$6,$7)`,
            [company_id, walletAccountId, issuedAmt,
             `Fund issued — ${req.purpose}`, id, user_id, walletType]
          );
        }
      }

      return rows[0];
    });

    await logAudit({ companyId: company_id, userId: user_id, action: 'issue',
      entityType: 'fund_request', entityId: id,
      newValues: { status: newStatus, amount_issued: totalIssued } });

    return result;
  });

  // ── PATCH /api/finance/requests/:id/complete ─────────────────
  app.patch('/requests/:id/complete', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;

    const { rows: existing } = await query(
      `SELECT * FROM fund_requests WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) return reply.status(404).send({ error: 'Fund request not found' });

    const { rows } = await query(
      `UPDATE fund_requests
       SET status = 'completed', completed_at = now(), updated_at = now()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [id, company_id]
    );

    await logAudit({ companyId: company_id, userId: user_id, action: 'complete',
      entityType: 'fund_request', entityId: id,
      oldValues: { status: existing[0].status }, newValues: { status: 'completed' } });

    return rows[0];
  });

  // ── GET /api/finance/transactions ─────────────────────────────
  app.get('/transactions', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          account_id:       { type: 'string' },
          transaction_type: { type: 'string', enum: ['inflow', 'outflow', 'transfer', 'opening_balance'] },
          reference_type:   { type: 'string' },
          from:             { type: 'string' },
          to:               { type: 'string' },
          limit:            { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset:           { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, _reply) => {
    const { company_id } = request.user;
    const { account_id, transaction_type, reference_type, from, to, limit, offset } = request.query;

    const conditions = ['t.company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (account_id)       { conditions.push(`t.account_id       = $${p++}`); params.push(account_id); }
    if (transaction_type) { conditions.push(`t.transaction_type = $${p++}`); params.push(transaction_type); }
    if (reference_type)   { conditions.push(`t.reference_type   = $${p++}`); params.push(reference_type); }
    if (from)             { conditions.push(`t.created_at      >= $${p++}`); params.push(from); }
    if (to)               { conditions.push(`t.created_at      <= $${p++}`); params.push(to); }

    params.push(limit, offset);

    const { rows } = await query(
      `SELECT t.*,
              a.account_name,
              cc.card_name, cc.last_four
       FROM fund_transactions t
       LEFT JOIN fund_accounts a ON a.id = t.account_id
       LEFT JOIN corporate_cards cc ON cc.id = t.card_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY t.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS total FROM fund_transactions t WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2)
    );

    return { data: rows, total: parseInt(countRows[0].total, 10), limit, offset };
  });

  // ── POST /api/finance/transactions ───────────────────────────
  // Direct transaction entry (expense recording)
  app.post('/transactions', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['transaction_type', 'amount'],
        properties: {
          account_id:              { type: 'string' },
          transaction_type:        { type: 'string', enum: ['inflow', 'outflow', 'transfer', 'opening_balance'] },
          amount:                  { type: 'number', exclusiveMinimum: 0 },
          description:             { type: 'string' },
          category:                { type: 'string' },
          vendor:                  { type: 'string' },
          vat_number:              { type: 'string' },
          card_id:                 { type: 'string' },
          category_id:             { type: 'string' },
          is_raw_material_payment: { type: 'boolean', default: false },
          reference_id:            { type: 'string' },
          reference_type:          { type: 'string' },
          receipt_url:             { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: created_by } = request.user;
    const {
      account_id, transaction_type, amount, description, category,
      vendor, vat_number, card_id, category_id,
      is_raw_material_payment = false, reference_id, reference_type, receipt_url,
    } = request.body;

    // Coerce empty-string UUIDs to null (Fastify passes "" for optional uuid fields)
    const safeCardId     = card_id      || null;
    const safeCategoryId = category_id  || null;

    // walletType is determined SOLELY by is_raw_material_payment flag.
    // account_id in the body may be a card or bank account for tracking purposes —
    // it must NOT override which virtual wallet is debited/credited.
    const walletType = is_raw_material_payment ? 'raw_materials' : 'petty_cash';

    // Always resolve the wallet account by type, ignoring any passed account_id for balance logic
    let resolvedAccountId = null;
    {
      const { rows: acctRows } = await query(
        `SELECT id FROM fund_accounts WHERE company_id = $1 AND account_type = $2 LIMIT 1`,
        [company_id, walletType]
      );
      if (acctRows.length > 0) resolvedAccountId = acctRows[0].id;
    }

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO fund_transactions
           (company_id, account_id, transaction_type, amount, description, category,
            vendor, vat_number, card_id, category_id, is_raw_material_payment,
            reference_id, reference_type, receipt_url, created_by, wallet_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [company_id, resolvedAccountId, transaction_type, amount, description ?? null,
         category ?? null, vendor ?? null, vat_number ?? null, safeCardId,
         safeCategoryId, is_raw_material_payment, reference_id ?? null,
         reference_type ?? null, receipt_url ?? null, created_by,
         walletType]
      );

      // Update account balance
      if (resolvedAccountId) {
        const delta = transaction_type === 'outflow' ? -amount : amount;
        await client.query(
          `UPDATE fund_accounts SET current_balance = current_balance + $1 WHERE id = $2 AND company_id = $3`,
          [delta, resolvedAccountId, company_id]
        );
      }

      // Update card balance
      if (safeCardId) {
        const delta = transaction_type === 'outflow' ? -amount : amount;
        await client.query(
          `UPDATE corporate_cards SET current_balance = current_balance + $1 WHERE id = $2 AND company_id = $3`,
          [delta, safeCardId, company_id]
        );
      }

      return rows[0];
    });

    return reply.status(201).send(result);
  });

  // ── POST /api/finance/transactions/:id/reverse ───────────────
  // Creates a reversal entry (audit trail, no hard delete)
  app.post('/transactions/:id/reverse', {
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
    const reason = request.body?.reason ?? 'Transaction reversed';

    const { rows: existing } = await query(
      `SELECT * FROM fund_transactions WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) return reply.status(404).send({ error: 'Transaction not found' });

    const orig = existing[0];

    const result = await withTransaction(async (client) => {
      // Insert reversal entry (opposite type)
      const reversalType = orig.transaction_type === 'outflow' ? 'inflow' : 'outflow';
      const { rows } = await client.query(
        `INSERT INTO fund_transactions
           (company_id, account_id, transaction_type, amount, description,
            category, card_id, category_id, is_raw_material_payment,
            reference_id, reference_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reversal',$11)
         RETURNING *`,
        [company_id, orig.account_id, reversalType, orig.amount,
         `REVERSAL: ${reason} (ref ${orig.transaction_number ?? id})`,
         orig.category, orig.card_id, orig.category_id,
         orig.is_raw_material_payment ?? false, id, user_id]
      );

      // Undo account balance
      if (orig.account_id) {
        const delta = orig.transaction_type === 'outflow' ? orig.amount : -orig.amount;
        await client.query(
          `UPDATE fund_accounts SET current_balance = current_balance + $1 WHERE id = $2 AND company_id = $3`,
          [delta, orig.account_id, company_id]
        );
      }

      // Undo card balance
      if (orig.card_id) {
        const delta = orig.transaction_type === 'outflow' ? orig.amount : -orig.amount;
        await client.query(
          `UPDATE corporate_cards SET current_balance = current_balance + $1 WHERE id = $2 AND company_id = $3`,
          [delta, orig.card_id, company_id]
        );
      }

      return rows[0];
    });

    await logAudit({ companyId: company_id, userId: user_id, action: 'reverse',
      entityType: 'fund_transaction', entityId: id, reason });

    return reply.status(201).send(result);
  });

  // ── DELETE /api/finance/requests/:id ─────────────────────────
  // Soft-delete: only allowed for non-posted (submitted / rejected) requests
  app.delete('/requests/:id', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;

    const { rows: existing } = await query(
      `SELECT id, status FROM fund_requests WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) return reply.status(404).send({ error: 'Fund request not found' });

    const { status } = existing[0];
    const postedStatuses = ['approved','manager_approved','funds_issued','completed','paid'];
    if (postedStatuses.includes(status)) {
      return reply.status(409).send({ error: 'Cannot delete an approved or posted fund request' });
    }

    await query(
      `UPDATE fund_requests SET deleted_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );

    await logAudit({ companyId: company_id, userId: user_id, action: 'delete',
      entityType: 'fund_request', entityId: id,
      oldValues: { status }, reason: 'Soft-deleted from queue' });

    return reply.status(204).send();
  });

  // ── PATCH /api/finance/requests/:id/reset-issue ──────────────
  // Reverse a cheque issuance — return request to 'approved' state
  app.patch('/requests/:id/reset-issue', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;

    const { rows: existing } = await query(
      `SELECT * FROM fund_requests WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) return reply.status(404).send({ error: 'Fund request not found' });

    const req = existing[0];
    const approvedAmt = req.approved_amount ?? req.amount;

    const { rows } = await query(
      `UPDATE fund_requests
       SET status = 'approved', check_number = NULL, issued_at = NULL,
           completed_at = NULL, payment_method = NULL,
           amount_issued = 0, remaining_amount = $1, updated_at = now()
       WHERE id = $2 AND company_id = $3
       RETURNING *`,
      [approvedAmt, id, company_id]
    );

    await logAudit({ companyId: company_id, userId: user_id, action: 'reset_issue',
      entityType: 'fund_request', entityId: id,
      oldValues: { status: req.status }, newValues: { status: 'approved' } });

    return rows[0];
  });

  // ── POST /api/finance/requests/:id/reverse-all ───────────────
  // Reverse all linked fund_transactions + reset request to 'approved'
  app.post('/requests/:id/reverse-all', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: { reason: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;
    const reason = request.body?.reason ?? 'Full reversal';

    const { rows: existing } = await query(
      `SELECT * FROM fund_requests WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) return reply.status(404).send({ error: 'Fund request not found' });

    const req = existing[0];
    const approvedAmt = req.approved_amount ?? req.amount;

    // Find all non-reversed linked transactions
    const { rows: linked } = await query(
      `SELECT * FROM fund_transactions
       WHERE reference_id = $1 AND company_id = $2
         AND reference_type != 'reversal'`,
      [id, company_id]
    );

    const result = await withTransaction(async (client) => {
      for (const tx of linked) {
        const reversalType = tx.transaction_type === 'outflow' ? 'inflow' : 'outflow';
        await client.query(
          `INSERT INTO fund_transactions
             (company_id, account_id, transaction_type, amount, description,
              category, card_id, category_id, is_raw_material_payment,
              reference_id, reference_type, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reversal',$11)`,
          [company_id, tx.account_id, reversalType, tx.amount,
           `REVERSAL: ${reason} (ref ${tx.transaction_number ?? tx.id})`,
           tx.category, tx.card_id, tx.category_id,
           tx.is_raw_material_payment ?? false, tx.id, user_id]
        );
        if (tx.account_id) {
          const delta = tx.transaction_type === 'outflow' ? tx.amount : -tx.amount;
          await client.query(
            `UPDATE fund_accounts SET current_balance = current_balance + $1 WHERE id = $2 AND company_id = $3`,
            [delta, tx.account_id, company_id]
          );
        }
        if (tx.card_id) {
          const delta = tx.transaction_type === 'outflow' ? tx.amount : -tx.amount;
          await client.query(
            `UPDATE corporate_cards SET current_balance = current_balance + $1 WHERE id = $2 AND company_id = $3`,
            [delta, tx.card_id, company_id]
          );
        }
      }

      const { rows } = await client.query(
        `UPDATE fund_requests
         SET status = 'approved', check_number = NULL, issued_at = NULL,
             completed_at = NULL, payment_method = NULL,
             amount_issued = 0, remaining_amount = $1, updated_at = now()
         WHERE id = $2 AND company_id = $3
         RETURNING *`,
        [approvedAmt, id, company_id]
      );

      return rows[0];
    });

    await logAudit({ companyId: company_id, userId: user_id, action: 'reverse_all',
      entityType: 'fund_request', entityId: id,
      reason, newValues: { reversed_tx_count: linked.length } });

    return { ...result, reversed_count: linked.length };
  });

  // ── GET /api/finance/wallets ──────────────────────────────────
  app.get('/wallets', { preHandler: [app.authenticate] }, async (request, _reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT account_type, account_name, currency, current_balance
       FROM fund_accounts
       WHERE company_id = $1
       ORDER BY account_type`,
      [company_id]
    );
    const result = { petty_cash: 0, raw_materials: 0, total: 0 };
    for (const r of rows) {
      const bal = parseFloat(r.current_balance || 0);
      if (r.account_type === 'petty_cash') result.petty_cash = bal;
      if (r.account_type === 'raw_materials') result.raw_materials = bal;
      result.total += bal;
    }
    result.accounts = rows;
    return result;
  });
  // ── GET /api/finance/fund-request-purposes ───────────────────
  app.get("/fund-request-purposes", { preHandler: [app.authenticate] }, async (request, _reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT id, label, sort_order FROM fund_request_purposes
       WHERE company_id = $1 AND is_active = true ORDER BY sort_order`,
      [company_id]
    );
    return { data: rows };
  });



  // ── POST /api/finance/supplier-requests — request a new vendor (CEO approves)
  app.post('/supplier-requests', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, id: user_id } = request.user;
    const { name, contact_person, phone, email, address, currency,
            bank_name, bank_account_number, iban, swift_code, services_provided, notes,
            price_per_service } = request.body;
    if (!name) return reply.status(400).send({ error: 'name is required' });
    const { rows } = await query(
      `INSERT INTO supplier_requests
         (company_id, name, contact_person, phone, email, address, currency,
          bank_name, bank_account_number, iban, swift_code, services_provided, notes, price_per_service, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [company_id, name, contact_person ?? null, phone ?? null, email ?? null,
       address ?? null, currency ?? 'SAR', bank_name ?? null,
       bank_account_number ?? null, iban ?? null, swift_code ?? null,
       services_provided ?? null, notes ?? null,
       price_per_service ?? null, user_id]
    );
    return reply.status(201).send(rows[0]);
  });


  // ── POST /api/finance/fund-requests/upload-document ──────────
  app.post('/fund-requests/upload-document', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { file_data, file_name } = request.body;
    if (!file_data || !file_name) return reply.status(400).send({ error: 'file_data and file_name required' });
    const fs = await import('fs');
    const path = await import('path');
    const safeBase = path.basename(file_name).replace(/[^a-zA-Z0-9._-]/g, '_');
    const ts = Date.now();
    const fname = `${ts}_${safeBase}`;
    const uploadDir = '/var/www/tarsyn-core/uploads/fund-requests';
    const fullPath = path.join(uploadDir, fname);
    const base64Data = file_data.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(fullPath, buffer);
    const url = `/uploads/fund-requests/${fname}`;
    return { url };
  });

  // ── POST /api/finance/requests/:id/upload-remittance ──────────
  app.post('/requests/:id/upload-remittance', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { file_data, file_name } = request.body;
    if (!file_data || !file_name) return reply.status(400).send({ error: 'file_data and file_name required' });
    const fs = await import('fs');
    const path = await import('path');
    const safeBase = path.basename(file_name).replace(/[^a-zA-Z0-9._-]/g, '_');
    const fname = `${Date.now()}_${safeBase}`;
    const uploadDir = '/var/www/tarsyn-core/uploads/remittances';
    fs.mkdirSync(uploadDir, { recursive: true });
    const fullPath = path.join(uploadDir, fname);
    const base64Data = file_data.replace(/^data:[^;]+;base64,/, '');
    fs.writeFileSync(fullPath, Buffer.from(base64Data, 'base64'));
    const url = `/uploads/remittances/${fname}`;
    await query(
      `UPDATE fund_requests SET remittance_url = $1, updated_at = now() WHERE id = $2 AND company_id = $3`,
      [url, id, company_id]
    );
    return { url };
  });
  // ── POST /api/finance/invoices/upload ──────────────────────────
  app.post('/invoices/upload', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { file_data, file_name, order_id } = request.body ?? {};
    if (!file_data || !file_name) return reply.status(400).send({ error: 'file_data and file_name required' });
    const fs = await import('fs');
    const path = await import('path');
    const safeBase = path.basename(file_name).replace(/[^a-zA-Z0-9._-]/g, '_');
    const fname = `${Date.now()}_${order_id ? order_id + '_' : ''}${safeBase}`;
    const uploadDir = '/var/www/tarsyn-core/uploads/invoices';
    fs.mkdirSync(uploadDir, { recursive: true });
    const fullPath = path.join(uploadDir, fname);
    const base64Data = file_data.replace(/^data:[^;]+;base64,/, '');
    fs.writeFileSync(fullPath, Buffer.from(base64Data, 'base64'));
    const url = `/uploads/invoices/${fname}`;
    return reply.status(200).send({ url });
  });

}