import { query } from '../../db.js';

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
          account_type:    { type: 'string', enum: ['petty_cash', 'bank', 'corporate_card'] },
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
          status:  { type: 'string' },
          from:    { type: 'string' },
          to:      { type: 'string' },
          limit:   { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset:  { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, _reply) => {
    const { company_id } = request.user;
    const { status, from, to, limit, offset } = request.query;

    const conditions = ['company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (status) { conditions.push(`status     = $${p++}`); params.push(status); }
    if (from)   { conditions.push(`created_at >= $${p++}`); params.push(from); }
    if (to)     { conditions.push(`created_at <= $${p++}`); params.push(to);   }

    params.push(limit, offset);

    const { rows } = await query(
      `SELECT id, amount, purpose, status, requested_by, approved_by, approved_at, created_at
       FROM fund_requests
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS total FROM fund_requests WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2)
    );

    return { data: rows, total: parseInt(countRows[0].total, 10), limit, offset };
  });

  // ── POST /api/finance/requests ────────────────────────────────
  app.post('/requests', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['amount', 'purpose'],
        properties: {
          amount:  { type: 'number', exclusiveMinimum: 0 },
          purpose: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: requested_by } = request.user;
    const { amount, purpose } = request.body;

    const { rows } = await query(
      `INSERT INTO fund_requests (company_id, requested_by, amount, purpose)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [company_id, requested_by, amount, purpose.trim()]
    );

    return reply.status(201).send(rows[0]);
  });

  // ── PATCH /api/finance/requests/:id/approve ───────────────────
  app.patch('/requests/:id/approve', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id, sub: approved_by } = request.user;
    const { id } = request.params;

    const { rows: existing } = await query(
      `SELECT id, status FROM fund_requests WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );

    if (existing.length === 0) {
      return reply.status(404).send({ error: 'Fund request not found' });
    }
    if (existing[0].status !== 'submitted') {
      return reply.status(409).send({ error: `Cannot approve a request with status '${existing[0].status}'` });
    }

    const { rows } = await query(
      `UPDATE fund_requests
       SET status = 'approved', approved_by = $1, approved_at = now(), updated_at = now()
       WHERE id = $2 AND company_id = $3
       RETURNING *`,
      [approved_by, id, company_id]
    );

    return rows[0];
  });

  // ── PATCH /api/finance/requests/:id/reject ────────────────────
  app.patch('/requests/:id/reject', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id, sub: approved_by } = request.user;
    const { id } = request.params;

    const { rows: existing } = await query(
      `SELECT id, status FROM fund_requests WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );

    if (existing.length === 0) {
      return reply.status(404).send({ error: 'Fund request not found' });
    }
    if (existing[0].status !== 'submitted') {
      return reply.status(409).send({ error: `Cannot reject a request with status '${existing[0].status}'` });
    }

    const { rows } = await query(
      `UPDATE fund_requests
       SET status = 'rejected', approved_by = $1, approved_at = now(), updated_at = now()
       WHERE id = $2 AND company_id = $3
       RETURNING *`,
      [approved_by, id, company_id]
    );

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
          transaction_type: { type: 'string', enum: ['inflow', 'outflow', 'transfer'] },
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

    if (account_id)       { conditions.push(`t.account_id       = $${p++}`); params.push(account_id);       }
    if (transaction_type) { conditions.push(`t.transaction_type = $${p++}`); params.push(transaction_type); }
    if (reference_type)   { conditions.push(`t.reference_type   = $${p++}`); params.push(reference_type);   }
    if (from)             { conditions.push(`t.created_at      >= $${p++}`); params.push(from);             }
    if (to)               { conditions.push(`t.created_at      <= $${p++}`); params.push(to);               }

    params.push(limit, offset);

    const { rows } = await query(
      `SELECT t.id, t.transaction_type, t.amount, t.description, t.category,
              t.reference_id, t.reference_type, t.created_at, t.created_by,
              a.account_name
       FROM fund_transactions t
       LEFT JOIN fund_accounts a ON a.id = t.account_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY t.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS total FROM fund_transactions t
       WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2)
    );

    return { data: rows, total: parseInt(countRows[0].total, 10), limit, offset };
  });
}
