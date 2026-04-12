import { query, withTransaction } from '../../db.js';

export default async function byproductRoutes(app) {

  // ── Buyers ────────────────────────────────────────────────────

  const buyerHandler = async (request) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT id, name, contact_name, contact_phone, is_active, created_at
       FROM byproduct_buyers WHERE company_id = $1 ORDER BY name`,
      [company_id]
    );
    return { data: rows };
  };
  app.get('/byproduct-buyers', { preHandler: [app.authenticate] }, buyerHandler);
  app.get('/by-products',      { preHandler: [app.authenticate] }, buyerHandler);

  app.post('/byproduct-buyers', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { name, contact_name, contact_phone } = request.body;
    const { rows } = await query(
      `INSERT INTO byproduct_buyers (company_id, name, contact_name, contact_phone)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [company_id, name, contact_name ?? null, contact_phone ?? null]
    );
    return reply.status(201).send(rows[0]);
  });

  // ── Sales ─────────────────────────────────────────────────────

  const salesQuerySchema = {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          item_type: { type: 'string' },
          buyer_id:  { type: 'string' },
          status:    { type: 'string' },
          from:      { type: 'string' },
          to:        { type: 'string' },
          limit:     { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset:    { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  };

  const salesHandler = async (request) => {
    const { company_id } = request.user;
    const { item_type, buyer_id, status, from, to, limit = 50, offset = 0 } = request.query;

    const conditions = ['s.company_id = $1'];
    const params = [company_id];
    let p = 2;
    if (item_type) { conditions.push(`s.item_type = $${p++}`); params.push(item_type); }
    if (buyer_id)  { conditions.push(`s.buyer_id = $${p++}`);  params.push(buyer_id); }
    if (status)    { conditions.push(`s.status = $${p++}`);    params.push(status); }
    if (from)      { conditions.push(`s.sale_date >= $${p++}`);params.push(from); }
    if (to)        { conditions.push(`s.sale_date <= $${p++}`);params.push(to); }
    params.push(limit, offset);

    const { rows } = await query(
      `SELECT s.id, s.item_type, s.quantity_mt, s.price_per_mt, s.total_amount,
              s.sale_date, s.status, s.notes, s.reversal_of, s.created_at,
              s.approved_at, s.rejection_reason,
              b.name AS buyer_name,
              u.full_name AS created_by_name,
              av.full_name AS approved_by_name
       FROM byproduct_sales s
       LEFT JOIN byproduct_buyers b ON b.id = s.buyer_id
       LEFT JOIN users u ON u.id = s.created_by
       LEFT JOIN users av ON av.id = s.approved_by
       WHERE ${conditions.join(' AND ')}
       ORDER BY s.sale_date DESC, s.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS total FROM byproduct_sales s WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2)
    );

    return { data: rows, total: parseInt(countRows[0].total, 10), limit, offset };
  };

  app.get('/byproduct-sales',   { preHandler: [app.authenticate], ...salesQuerySchema }, salesHandler);
  app.get('/by-product-sales',  { preHandler: [app.authenticate], ...salesQuerySchema }, salesHandler);
  app.get('/by-products-sales', { preHandler: [app.authenticate], ...salesQuerySchema }, salesHandler);

  // POST /api/production/byproduct-sales
  // Submits a sale for CEO approval — does NOT touch inventory until approved
  app.post('/byproduct-sales', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: created_by } = request.user;
    const { buyer_id, item_type = 'copper', quantity_mt, price_per_mt, sale_date, notes } = request.body;

    if (!quantity_mt || Number(quantity_mt) <= 0) {
      return reply.status(400).send({ error: 'quantity_mt must be positive' });
    }

    // Validate stock availability
    const { rows: stock } = await query(
      `SELECT quantity_mt FROM inventory_items WHERE company_id = $1 AND item_type = $2`,
      [company_id, item_type]
    );
    const available = stock.length ? Number(stock[0].quantity_mt) : 0;
    if (Number(quantity_mt) > available) {
      return reply.status(409).send({ error: `Insufficient stock — ${available.toFixed(3)} MT available` });
    }

    const { rows } = await query(
      `INSERT INTO byproduct_sales
         (company_id, buyer_id, item_type, quantity_mt, price_per_mt, sale_date, notes, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_approval',$8)
       RETURNING *`,
      [company_id, buyer_id ?? null, item_type, quantity_mt, price_per_mt ?? 0,
       sale_date ?? new Date().toISOString().split('T')[0], notes ?? null, created_by]
    );

    return reply.status(201).send(rows[0]);
  });

  // POST /api/production/byproduct-sales/:id/approve
  // CEO approves: deducts inventory, credits petty_cash wallet
  app.post('/byproduct-sales/:id/approve', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: approved_by } = request.user;
    const { id } = request.params;

    const result = await withTransaction(async (client) => {
      const { rows: orig } = await client.query(
        `SELECT * FROM byproduct_sales WHERE id = $1 AND company_id = $2 AND status = 'pending_approval'`,
        [id, company_id]
      );
      if (!orig.length) throw Object.assign(new Error('Sale not found or not pending approval'), { statusCode: 404 });

      const sale   = orig[0];
      const qty    = Number(sale.quantity_mt);
      const pricePer = Number(sale.price_per_mt);
      const totalAmt = Number(sale.total_amount ?? (qty * pricePer));

      // 1. Mark sale as active
      const { rows: updated } = await client.query(
        `UPDATE byproduct_sales SET status = 'active', approved_by = $1, approved_at = now()
         WHERE id = $2 RETURNING *`,
        [approved_by, id]
      );

      // 2. Deduct copper stock
      await client.query(
        `UPDATE inventory_items SET quantity_mt = quantity_mt - $1, last_updated = now()
         WHERE company_id = $2 AND item_type = $3`,
        [qty, company_id, sale.item_type]
      );

      // 3. Log inventory movement
      await client.query(
        `INSERT INTO inventory_logs (company_id, item_type, change_mt, reason, reference_type, created_by)
         VALUES ($1,$2,$3,'Byproduct sale (CEO approved)','byproduct_sale',$4)`,
        [company_id, sale.item_type, -qty, approved_by]
      );

      // 4. Credit proceeds to petty_cash wallet
      if (totalAmt > 0) {
        const { rows: acctRows } = await client.query(
          `SELECT id FROM fund_accounts WHERE company_id = $1 AND account_type = 'petty_cash' LIMIT 1`,
          [company_id]
        );
        if (acctRows.length > 0) {
          const acctId = acctRows[0].id;
          await client.query(
            `UPDATE fund_accounts SET current_balance = current_balance + $1 WHERE id = $2`,
            [totalAmt, acctId]
          );
          await client.query(
            `INSERT INTO fund_transactions
               (company_id, account_id, transaction_type, amount, description,
                category, reference_id, reference_type, created_by, wallet_type)
             VALUES ($1,$2,'inflow',$3,$4,'byproduct_sale',$5,'byproduct_sale',$6,'petty_cash')`,
            [company_id, acctId, totalAmt,
             `Copper sale — ${qty.toFixed(3)} MT @ ${pricePer.toFixed(2)} SAR/MT`,
             id, approved_by]
          );
        }
      }

      return updated[0];
    });

    return result;
  });

  // POST /api/production/byproduct-sales/:id/reject
  app.post('/byproduct-sales/:id/reject', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: rejected_by } = request.user;
    const { id } = request.params;
    const { reason } = request.body ?? {};

    const { rows: orig } = await query(
      `SELECT id FROM byproduct_sales WHERE id = $1 AND company_id = $2 AND status = 'pending_approval'`,
      [id, company_id]
    );
    if (!orig.length) return reply.status(404).send({ error: 'Sale not found or not pending approval' });

    const { rows } = await query(
      `UPDATE byproduct_sales
       SET status = 'rejected', approved_by = $1, approved_at = now(), rejection_reason = $2
       WHERE id = $3 RETURNING *`,
      [rejected_by, reason ?? 'Rejected', id]
    );
    return rows[0];
  });

  // POST /api/production/byproduct-sales/:id/reverse — reverse an active sale
  app.post('/byproduct-sales/:id/reverse', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: created_by } = request.user;
    const { id } = request.params;
    const { reason } = request.body ?? {};

    const result = await withTransaction(async (client) => {
      const { rows: orig } = await client.query(
        `SELECT * FROM byproduct_sales WHERE id = $1 AND company_id = $2 AND status = 'active'`,
        [id, company_id]
      );
      if (!orig.length) throw Object.assign(new Error('Sale not found or already reversed'), { statusCode: 404 });

      const sale = orig[0];
      await client.query(`UPDATE byproduct_sales SET status = 'reversed' WHERE id = $1`, [id]);
      await client.query(
        `UPDATE inventory_items SET quantity_mt = quantity_mt + $1, last_updated = now()
         WHERE company_id = $2 AND item_type = $3`,
        [sale.quantity_mt, company_id, sale.item_type]
      );
      await client.query(
        `INSERT INTO inventory_logs (company_id, item_type, change_mt, reason, reference_type, created_by)
         VALUES ($1,$2,$3,$4,'byproduct_reversal',$5)`,
        [company_id, sale.item_type, sale.quantity_mt, reason ?? 'Byproduct sale reversal', created_by]
      );

      const totalAmt = Number(sale.total_amount ?? 0);
      if (totalAmt > 0) {
        const { rows: acctRows } = await client.query(
          `SELECT id FROM fund_accounts WHERE company_id = $1 AND account_type = 'petty_cash' LIMIT 1`,
          [company_id]
        );
        if (acctRows.length > 0) {
          const acctId = acctRows[0].id;
          await client.query(
            `UPDATE fund_accounts SET current_balance = current_balance - $1 WHERE id = $2`,
            [totalAmt, acctId]
          );
          await client.query(
            `INSERT INTO fund_transactions
               (company_id, account_id, transaction_type, amount, description,
                category, reference_id, reference_type, created_by, wallet_type)
             VALUES ($1,$2,'outflow',$3,$4,'byproduct_reversal',$5,'byproduct_sale',$6,'petty_cash')`,
            [company_id, acctId, totalAmt,
             `REVERSAL: ${reason ?? 'Byproduct sale reversed'}`, id, created_by]
          );
        }
      }

      const { rows: rev } = await client.query(
        `INSERT INTO byproduct_sales
           (company_id, buyer_id, item_type, quantity_mt, price_per_mt, sale_date, notes, status, reversal_of, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'reversed',$8,$9) RETURNING id`,
        [company_id, sale.buyer_id, sale.item_type, -sale.quantity_mt,
         sale.price_per_mt, sale.sale_date, reason ?? 'Reversal', id, created_by]
      );
      return { reversed_id: id, reversal_id: rev[0].id };
    });

    return result;
  });

  // ── Additional production endpoints ────────────────────────────

  app.get('/stock-ledger', { preHandler: [app.authenticate] }, async (request) => {
    const { company_id } = request.user;
    const { from, to, limit = 100, offset = 0 } = request.query;
    const conditions = ['company_id = $1'];
    const params = [company_id];
    let p = 2;
    if (from) { conditions.push(`created_at >= $${p++}`); params.push(from); }
    if (to)   { conditions.push(`created_at <= $${p++}`); params.push(to); }
    params.push(limit, offset);
    const { rows } = await query(
      `SELECT id, item_type, change_mt, reason, reference_id, reference_type, created_at, created_by
       FROM inventory_logs WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${p} OFFSET $${p + 1}`,
      params
    );
    return { data: rows };
  });

  app.get('/raw-materials', { preHandler: [app.authenticate] }, async (request) => {
    const { company_id } = request.user;
    const { limit = 50, offset = 0, status } = request.query;
    const conditions = ['r.company_id = $1'];
    const params = [company_id];
    let p = 2;
    if (status) { conditions.push(`r.status = $${p++}`); params.push(status); }
    params.push(limit, offset);
    const { rows } = await query(
      `SELECT r.id, r.purchase_date, r.material_type, r.tonnage,
              r.purchase_amount, r.transport_cost, r.status, r.created_at, s.name AS supplier_name
       FROM raw_material_purchases r LEFT JOIN suppliers s ON s.id = r.supplier_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY r.purchase_date DESC LIMIT $${p} OFFSET $${p + 1}`,
      params
    );
    return { data: rows };
  });

  app.get('/raw-material-intakes', { preHandler: [app.authenticate] }, async (request) => {
    const { company_id } = request.user;
    const { limit = 50, offset = 0 } = request.query;
    const { rows } = await query(
      `SELECT r.id, r.purchase_date, r.material_type, r.tonnage,
              r.purchase_amount, r.transport_cost, r.status, r.created_at, s.name AS supplier_name
       FROM raw_material_purchases r LEFT JOIN suppliers s ON s.id = r.supplier_id
       WHERE r.company_id = $1 ORDER BY r.purchase_date DESC LIMIT $2 OFFSET $3`,
      [company_id, limit, offset]
    );
    return { data: rows };
  });

  app.get('/completed-orders', { preHandler: [app.authenticate] }, async (request) => {
    const { company_id } = request.user;
    const { limit = 50, offset = 0 } = request.query;
    const { rows } = await query(
      `SELECT o.id, o.po_number, o.material, o.quantity, o.unit,
              o.price_per_mt_usd, o.usd_to_sar_rate, o.status, o.created_at,
              ROUND((o.price_per_mt_usd * o.quantity)::numeric, 2) AS total_value_usd,
              c.name AS client_name
       FROM production_orders o LEFT JOIN clients c ON c.id = o.client_id
       WHERE o.company_id = $1 AND o.status IN ('completed','shipped')
       ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`,
      [company_id, limit, offset]
    );
    return { data: rows };
  });

  app.get('/supplier-requests',     { preHandler: [app.authenticate] }, async () => ({ data: [] }));
  app.get('/price-change-requests', { preHandler: [app.authenticate] }, async () => ({ data: [] }));

  app.get('/inventory', { preHandler: [app.authenticate] }, async (request) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT item_type, quantity_mt, last_updated FROM inventory_items WHERE company_id = $1 ORDER BY item_type`,
      [company_id]
    );
    return { data: rows };
  });
}
