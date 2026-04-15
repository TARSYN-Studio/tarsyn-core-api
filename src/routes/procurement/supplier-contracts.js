import { query } from '../../db.js';

export default async function supplierContractRoutes(app) {

  // GET /api/procurement/supplier-contracts?supplier_id=X
  app.get('/supplier-contracts', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { supplier_id } = request.query;
    if (!supplier_id) return reply.status(400).send({ error: 'supplier_id is required' });

    const { rows: contracts } = await query(
      `SELECT c.*, 
         COALESCE(
           json_agg(
             json_build_object(
               'id', p.id,
               'service_name', p.service_name,
               'price', p.price,
               'currency', p.currency,
               'unit', p.unit
             )
           ) FILTER (WHERE p.id IS NOT NULL), '[]'
         ) AS prices
       FROM supplier_contracts c
       LEFT JOIN supplier_contract_prices p ON p.contract_id = c.id
       WHERE c.company_id = $1 AND c.supplier_id = $2
       GROUP BY c.id
       ORDER BY c.created_at DESC`,
      [company_id, supplier_id]
    );
    return { data: contracts };
  });

  // POST /api/procurement/supplier-contracts
  app.post('/supplier-contracts', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const {
      supplier_id, contract_number, start_date, end_date,
      payment_terms, credit_days, notes, prices
    } = request.body;

    if (!supplier_id) return reply.status(400).send({ error: 'supplier_id is required' });

    const { rows } = await query(
      `INSERT INTO supplier_contracts
         (company_id, supplier_id, contract_number, start_date, end_date, payment_terms, credit_days, notes, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
       RETURNING *`,
      [company_id, supplier_id, contract_number ?? null, start_date ?? null,
       end_date ?? null, payment_terms ?? null, credit_days ?? 0, notes ?? null]
    );
    const contract = rows[0];

    let priceRows = [];
    if (Array.isArray(prices) && prices.length > 0) {
      for (const p of prices) {
        const { rows: pr } = await query(
          `INSERT INTO supplier_contract_prices (contract_id, service_name, price, currency, unit)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [contract.id, p.service_name ?? null, p.price ?? 0, p.currency ?? 'SAR', p.unit ?? null]
        );
        priceRows.push(pr[0]);
      }
    }

    return reply.status(201).send({ ...contract, prices: priceRows });
  });

  // PATCH /api/procurement/supplier-contracts/:id
  app.patch('/supplier-contracts/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { contract_number, start_date, end_date, payment_terms, credit_days, notes, is_active, prices } = request.body ?? {};

    const updates = [];
    const params = [company_id, id];
    let p = 3;

    const setField = (col, val) => { updates.push(`${col} = $${p++}`); params.push(val); };

    if (contract_number !== undefined) setField('contract_number', contract_number);
    if (start_date !== undefined) setField('start_date', start_date);
    if (end_date !== undefined) setField('end_date', end_date);
    if (payment_terms !== undefined) setField('payment_terms', payment_terms);
    if (credit_days !== undefined) setField('credit_days', credit_days);
    if (notes !== undefined) setField('notes', notes);
    if (is_active !== undefined) setField('is_active', is_active);

    let contract;
    if (updates.length > 0) {
      const { rows } = await query(
        `UPDATE supplier_contracts SET ${updates.join(', ')}
         WHERE company_id = $1 AND id = $2 RETURNING *`,
        params
      );
      if (!rows.length) return reply.status(404).send({ error: 'Contract not found' });
      contract = rows[0];
    } else {
      const { rows } = await query(
        `SELECT * FROM supplier_contracts WHERE company_id = $1 AND id = $2`,
        [company_id, id]
      );
      if (!rows.length) return reply.status(404).send({ error: 'Contract not found' });
      contract = rows[0];
    }

    let priceRows = [];
    if (Array.isArray(prices)) {
      await query(`DELETE FROM supplier_contract_prices WHERE contract_id = $1`, [id]);
      for (const pr of prices) {
        const { rows: inserted } = await query(
          `INSERT INTO supplier_contract_prices (contract_id, service_name, price, currency, unit)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [id, pr.service_name ?? null, pr.price ?? 0, pr.currency ?? 'SAR', pr.unit ?? null]
        );
        priceRows.push(inserted[0]);
      }
    } else {
      const { rows: existing } = await query(
        `SELECT * FROM supplier_contract_prices WHERE contract_id = $1`, [id]
      );
      priceRows = existing;
    }

    return { ...contract, prices: priceRows };
  });

  // DELETE /api/procurement/supplier-contracts/:id
  app.delete('/supplier-contracts/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { rows } = await query(
      `DELETE FROM supplier_contracts WHERE company_id = $1 AND id = $2 RETURNING id`,
      [company_id, id]
    );
    if (!rows.length) return reply.status(404).send({ error: 'Contract not found' });
    return { deleted: true, id: rows[0].id };
  });

}

