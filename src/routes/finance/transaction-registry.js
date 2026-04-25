import { query, withTransaction } from '../../db.js';
import { reverseDocument, sendReversalError } from '../../services/reversal.js';

export default async function transactionRegistryRoutes(app) {

  // GET /api/finance/transaction-registry — unified view
  app.get('/transaction-registry', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          source_type: { type: 'string' },
          date_range:  { type: 'string' },
          search:      { type: 'string' },
          limit:       { type: 'integer', minimum: 1, maximum: 1000, default: 500 },
          offset:      { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { source_type, date_range, search, limit, offset } = request.query;

    const conditions = ['company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (source_type && source_type !== 'all') {
      conditions.push(`source_type = $${p++}`);
      params.push(source_type);
    }
    if (date_range && date_range !== 'all') {
      const days = parseInt(date_range, 10);
      conditions.push(`created_at >= $${p++}`);
      params.push(new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());
    }
    if (search) {
      conditions.push(`(reference_number ILIKE $${p} OR description ILIKE $${p})`);
      params.push(`%${search}%`);
      p++;
    }

    params.push(limit, offset);

    const { rows } = await query(
      `SELECT id, source_type, action_type, amount, description, category,
              reference_number, is_deleted, is_reversal, status, created_at, created_by_name
       FROM v_transaction_registry
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    return { data: rows };
  });

  // GET /api/finance/fund-balances
  app.get('/fund-balances', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT account_type, account_name, current_balance, currency
       FROM fund_accounts WHERE company_id = $1 ORDER BY account_type`,
      [company_id]
    );
    const sumByType = (type) =>
      rows
        .filter((r) => r.account_type === type)
        .reduce((s, r) => s + Number(r.current_balance), 0);

    const pettyCash = sumByType('petty_cash');
    const rawMaterial = sumByType('raw_materials');
    const bank = sumByType('bank');

    return {
      data: rows,
      petty_cash: pettyCash,
      raw_material: rawMaterial,
      bank_total: bank,
      total: pettyCash + rawMaterial + bank,
    };
  });

  // POST /api/finance/transactions/:id/adjust
  app.post('/transactions/:id/adjust', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: created_by } = request.user;
    const { id } = request.params;
    const { new_amount, reason } = request.body ?? {};

    const result = await withTransaction(async (client) => {
      const { rows: orig } = await client.query(
        `SELECT * FROM fund_transactions WHERE id = $1 AND company_id = $2`,
        [id, company_id]
      );
      if (!orig.length) throw Object.assign(new Error('Transaction not found'), { statusCode: 404 });

      const tx = orig[0];
      const diff = Number(new_amount) - Number(tx.amount);
      const delta = tx.transaction_type === 'inflow' ? diff : -diff;

      await client.query(
        `UPDATE fund_transactions SET amount = $1, updated_at = now() WHERE id = $2`,
        [new_amount, id]
      );
      await client.query(
        `UPDATE fund_accounts SET current_balance = current_balance + $1 WHERE id = $2`,
        [delta, tx.account_id]
      );
      return { success: true, old_amount: tx.amount, new_amount };
    });

    return result;
  });

  // POST /api/finance/inventory-logs/:id/reverse
  // Inserts an opposing inventory_log row + decrements the
  // corresponding inventory_items.quantity_mt. Routed through
  // reverseDocument so the lock + idempotency check + audit
  // log are uniform with every other reversal in the system.
  app.post('/inventory-logs/:id/reverse', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: created_by } = request.user;
    const { id } = request.params;
    const reason = request.body?.reason ?? `Reversal of log ${id}`;

    try {
      const reversal = await reverseDocument({
        table: 'inventory_logs',
        id,
        companyId: company_id,
        userId: created_by,
        reason,
        insertReversal: async (client, orig) => {
          const { rows } = await client.query(
            `INSERT INTO inventory_logs
               (company_id, item_type, change_mt, reason,
                reference_type, created_by, reverses_id)
             VALUES ($1,$2,$3,$4,'reversal',$5,$6)
             RETURNING *`,
            [company_id, orig.item_type, -orig.change_mt, reason, created_by, orig.id]
          );
          return rows[0];
        },
        applySideEffect: async (client, orig) => {
          // Subtract the original change so the inventory snaps back
          // to the pre-log quantity.
          await client.query(
            `UPDATE inventory_items
                SET quantity_mt = quantity_mt - $1, last_updated = now()
              WHERE company_id = $2 AND item_type = $3`,
            [orig.change_mt, company_id, orig.item_type]
          );
        },
      });
      return reply.status(201).send({ reversed_id: id, reversal_id: reversal.id });
    } catch (err) {
      return sendReversalError(reply, err);
    }
  });
}
