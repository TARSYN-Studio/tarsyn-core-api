import { pool, withTransaction } from '../../db.js';

export default async function purchasesRoutes(app) {

  // ── GET /api/procurement/purchases ────────────────────────────
  app.get('/purchases', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          supplier_id:   { type: 'string' },
          status:        { type: 'string' },
          material_type: { type: 'string' },
          limit:         { type: 'integer', minimum: 1, maximum: 200, default: 25 },
          offset:        { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { supplier_id, status, material_type, limit, offset } = request.query;

    const conditions = ['p.company_id = $1'];
    const params = [company_id];
    let idx = 2;

    if (supplier_id)   { conditions.push(`p.supplier_id = $${idx++}`);   params.push(supplier_id); }
    if (status)        { conditions.push(`p.status = $${idx++}`);        params.push(status); }
    if (material_type) { conditions.push(`p.material_type = $${idx++}`); params.push(material_type); }

    params.push(limit, offset);

    const { rows } = await pool.query(
      `SELECT p.*,
              s.name AS supplier_name
       FROM raw_material_purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY p.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      params
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS total FROM raw_material_purchases p
       WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2)
    );

    return {
      data:  rows,
      total: parseInt(countRows[0].total, 10),
      limit,
      offset,
    };
  });

  // ── POST /api/procurement/purchases ───────────────────────────
  // Atomically:
  //   1. Insert purchase record
  //   2. Increment raw_scrap inventory by tonnage (MT)
  //   3. Debit the first fund account by (purchase_amount + transport_cost)
  app.post('/purchases', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['supplier_id', 'purchase_date', 'tonnage', 'purchase_amount'],
        properties: {
          supplier_id:     { type: 'string' },
          purchase_date:   { type: 'string' },
          material_type:   { type: 'string', default: 'raw_scrap' },
          tonnage:         { type: 'number', minimum: 0.0001 },
          purchase_amount: { type: 'number', minimum: 0 },
          transport_cost:  { type: 'number', minimum: 0, default: 0 },
          status:          { type: 'string', default: 'pending' },
          account_id:      { type: 'string' },  // optional — auto-selected if omitted
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: created_by } = request.user;
    const {
      supplier_id, purchase_date, material_type = 'raw_scrap',
      tonnage, purchase_amount, transport_cost = 0, status = 'pending',
      account_id: requested_account_id,
    } = request.body;

    // Verify supplier belongs to this company
    const { rows: supRows } = await pool.query(
      `SELECT id, name FROM suppliers WHERE id = $1 AND company_id = $2`,
      [supplier_id, company_id]
    );
    if (supRows.length === 0) {
      return reply.status(404).send({ error: 'Supplier not found' });
    }
    const supplierName = supRows[0].name;

    const totalCashOut = purchase_amount + transport_cost;

    const result = await withTransaction(async (client) => {
      // 1. Insert the purchase record
      const { rows: purchaseRows } = await client.query(
        `INSERT INTO raw_material_purchases
           (company_id, supplier_id, purchase_date, material_type,
            tonnage, purchase_amount, transport_cost, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          company_id, supplier_id, purchase_date, material_type,
          tonnage, purchase_amount, transport_cost, status, created_by,
        ]
      );
      const purchase = purchaseRows[0];

      // 2. Increment raw_scrap inventory (tonnage is already in MT)
      await client.query(
        `UPDATE inventory_items
         SET quantity_mt = quantity_mt + $1, last_updated = now()
         WHERE company_id = $2 AND item_type = 'raw_scrap'`,
        [tonnage, company_id]
      );

      // Write inventory log
      await client.query(
        `INSERT INTO inventory_logs
           (company_id, item_type, change_mt, reason, reference_id, reference_type, created_by)
         VALUES ($1, 'raw_scrap', $2, $3, $4, 'raw_material_purchase', $5)`,
        [
          company_id, tonnage,
          `Purchase from ${supplierName} — ${tonnage} MT on ${purchase_date}`,
          purchase.id, created_by,
        ]
      );

      // 3. Debit the fund account
      //    Find the requested account, or fall back to the first account for the company
      const accountQuery = requested_account_id
        ? `SELECT id, current_balance, account_name FROM fund_accounts WHERE id = $1 AND company_id = $2`
        : `SELECT id, current_balance, account_name FROM fund_accounts WHERE company_id = $1 ORDER BY created_at ASC LIMIT 1`;
      const accountParams = requested_account_id
        ? [requested_account_id, company_id]
        : [company_id];

      const { rows: accountRows } = await client.query(accountQuery, accountParams);

      let fundTransaction = null;
      if (accountRows.length > 0) {
        const account = accountRows[0];

        // Insert outflow transaction
        const { rows: txRows } = await client.query(
          `INSERT INTO fund_transactions
             (company_id, account_id, transaction_type, amount, description,
              category, reference_id, reference_type, created_by)
           VALUES ($1,$2,'outflow',$3,$4,'raw_material_purchase',$5,'raw_material_purchase',$6)
           RETURNING *`,
          [
            company_id, account.id, totalCashOut,
            `Raw material purchase — ${supplierName} — ${tonnage} MT`,
            purchase.id, created_by,
          ]
        );
        fundTransaction = txRows[0];

        // Decrement fund account balance
        await client.query(
          `UPDATE fund_accounts SET current_balance = current_balance - $1 WHERE id = $2`,
          [totalCashOut, account.id]
        );
      }

      return { purchase, fund_transaction: fundTransaction };
    });

    return reply.status(201).send(result);
  });

  // ── PATCH /api/procurement/purchases/:id/status ───────────────
  // When cancelling, reverses the inventory increment and credits the fund.
  app.patch('/purchases/:id/status', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['pending', 'approved', 'received', 'cancelled'] },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: created_by } = request.user;
    const { id } = request.params;
    const { status } = request.body;

    // Load the existing purchase
    const { rows: existing } = await pool.query(
      `SELECT p.*, s.name AS supplier_name
       FROM raw_material_purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       WHERE p.id = $1 AND p.company_id = $2`,
      [id, company_id]
    );

    if (existing.length === 0) {
      return reply.status(404).send({ error: 'Purchase not found' });
    }

    const purchase = existing[0];

    // If already cancelled, don't double-reverse
    if (purchase.status === 'cancelled' && status === 'cancelled') {
      return reply.status(409).send({ error: 'Purchase is already cancelled' });
    }

    if (status === 'cancelled' && purchase.status !== 'cancelled') {
      // Atomic reversal: decrement inventory + credit fund
      const result = await withTransaction(async (client) => {
        // Update status
        const { rows } = await client.query(
          `UPDATE raw_material_purchases SET status = 'cancelled'
           WHERE id = $1 AND company_id = $2 RETURNING *`,
          [id, company_id]
        );

        // Reverse inventory: subtract the tonnage that was added
        await client.query(
          `UPDATE inventory_items
           SET quantity_mt = GREATEST(0, quantity_mt - $1), last_updated = now()
           WHERE company_id = $2 AND item_type = 'raw_scrap'`,
          [purchase.tonnage, company_id]
        );

        // Write reversal inventory log
        await client.query(
          `INSERT INTO inventory_logs
             (company_id, item_type, change_mt, reason, reference_id, reference_type, created_by)
           VALUES ($1, 'raw_scrap', $2, $3, $4, 'raw_material_purchase_cancellation', $5)`,
          [
            company_id, -purchase.tonnage,
            `Purchase cancelled — ${purchase.supplier_name} — ${purchase.tonnage} MT on ${purchase.purchase_date}`,
            id, created_by,
          ]
        );

        // Credit the fund account — find the most recent outflow for this purchase
        const { rows: txRows } = await client.query(
          `SELECT account_id, amount FROM fund_transactions
           WHERE reference_id = $1 AND reference_type = 'raw_material_purchase'
             AND transaction_type = 'outflow' AND company_id = $2
           ORDER BY created_at DESC LIMIT 1`,
          [id, company_id]
        );

        if (txRows.length > 0) {
          const { account_id, amount } = txRows[0];

          // Insert credit/reversal transaction
          await client.query(
            `INSERT INTO fund_transactions
               (company_id, account_id, transaction_type, amount, description,
                category, reference_id, reference_type, created_by)
             VALUES ($1,$2,'inflow',$3,$4,'raw_material_purchase_cancellation',$5,'raw_material_purchase_cancellation',$6)`,
            [
              company_id, account_id, amount,
              `Cancellation refund — ${purchase.supplier_name} — ${purchase.purchase_date}`,
              id, created_by,
            ]
          );

          // Restore fund account balance
          await client.query(
            `UPDATE fund_accounts SET current_balance = current_balance + $1 WHERE id = $2`,
            [amount, account_id]
          );
        }

        return rows[0];
      });

      return result;
    }

    // Simple status update (no inventory/fund effect)
    const { rows } = await pool.query(
      `UPDATE raw_material_purchases SET status = $3
       WHERE id = $1 AND company_id = $2 RETURNING *`,
      [id, company_id, status]
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Purchase not found' });
    }

    return rows[0];
  });
}
