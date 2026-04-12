import { query, logAudit } from '../../db.js';

export default async function banksRoutes(app) {

  // ── GET /api/finance/employee-bank-accounts ───────────────────
  app.get('/employee-bank-accounts', {
    preHandler: [app.authenticate],
  }, async (request, _reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT * FROM employee_bank_accounts
       WHERE company_id = $1 AND is_active = true
       ORDER BY bank_name ASC`,
      [company_id]
    );
    return rows;
  });

  // ── POST /api/finance/employee-bank-accounts ──────────────────
  app.post('/employee-bank-accounts', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['bank_name'],
        properties: {
          user_id:        { type: 'string' },
          employee_name:  { type: 'string' },
          bank_name:      { type: 'string', minLength: 1 },
          account_number: { type: 'string' },
          iban:           { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { user_id, employee_name, bank_name, account_number, iban } = request.body;
    const { rows } = await query(
      `INSERT INTO employee_bank_accounts (company_id, user_id, employee_name, bank_name, account_number, iban)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [company_id, user_id ?? null, employee_name ?? null, bank_name.trim(), account_number ?? null, iban ?? null]
    );
    return reply.status(201).send(rows[0]);
  });


  // ── GET /api/finance/banks ────────────────────────────────────
  app.get('/banks', {
    preHandler: [app.authenticate],
  }, async (request, _reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT * FROM bank_accounts
       WHERE company_id = $1
       ORDER BY account_name ASC`,
      [company_id]
    );
    return rows;
  });

  // ── POST /api/finance/banks ───────────────────────────────────
  app.post('/banks', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['account_name'],
        properties: {
          account_name:    { type: 'string', minLength: 1 },
          bank_name:       { type: 'string' },
          account_number:  { type: 'string' },
          iban:            { type: 'string' },
          currency:        { type: 'string', default: 'SAR' },
          current_balance: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { account_name, bank_name, account_number, iban, currency, current_balance } = request.body;

    const { rows } = await query(
      `INSERT INTO bank_accounts
         (company_id, account_name, bank_name, account_number, iban, currency, current_balance)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [company_id, account_name.trim(), bank_name ?? null, account_number ?? null,
       iban ?? null, currency ?? 'SAR', current_balance ?? 0]
    );

    await logAudit({ companyId: company_id, userId: user_id, action: 'create',
      entityType: 'bank_account', entityId: rows[0].id, newValues: rows[0] });

    return reply.status(201).send(rows[0]);
  });

  // ── PATCH /api/finance/banks/:id ─────────────────────────────
  app.patch('/banks/:id', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          account_name:    { type: 'string' },
          bank_name:       { type: 'string' },
          account_number:  { type: 'string' },
          iban:            { type: 'string' },
          currency:        { type: 'string' },
          current_balance: { type: 'number' },
          is_active:       { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;

    const { rows: existing } = await query(
      `SELECT * FROM bank_accounts WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) return reply.status(404).send({ error: 'Bank account not found' });

    const fields = ['account_name','bank_name','account_number','iban','currency','current_balance','is_active'];
    const updates = [];
    const params = [];
    let p = 1;
    for (const f of fields) {
      if (request.body[f] !== undefined) { updates.push(`${f} = $${p++}`); params.push(request.body[f]); }
    }
    if (updates.length === 0) return reply.status(400).send({ error: 'No fields to update' });

    params.push(id, company_id);
    const { rows } = await query(
      `UPDATE bank_accounts SET ${updates.join(', ')} WHERE id = $${p} AND company_id = $${p + 1} RETURNING *`,
      params
    );

    await logAudit({ companyId: company_id, userId: user_id, action: 'update',
      entityType: 'bank_account', entityId: id, oldValues: existing[0], newValues: rows[0] });

    return rows[0];
  });

  // ── DELETE /api/finance/banks/:id ────────────────────────────
  app.delete('/banks/:id', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;

    const { rows: existing } = await query(
      `SELECT * FROM bank_accounts WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (existing.length === 0) return reply.status(404).send({ error: 'Bank account not found' });

    await query(`DELETE FROM bank_accounts WHERE id = $1 AND company_id = $2`, [id, company_id]);
    await logAudit({ companyId: company_id, userId: user_id, action: 'delete',
      entityType: 'bank_account', entityId: id, oldValues: existing[0] });

    return reply.status(204).send();
  });
}
