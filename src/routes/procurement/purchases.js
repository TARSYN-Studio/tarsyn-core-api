import { query } from '../../db.js';

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

    const { rows } = await query(
      `SELECT p.*,
              s.name AS supplier_name
       FROM raw_material_purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY p.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      params
    );

    const { rows: countRows } = await query(
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
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: created_by } = request.user;
    const {
      supplier_id, purchase_date, material_type = 'raw_scrap',
      tonnage, purchase_amount, transport_cost = 0, status = 'pending',
    } = request.body;

    // Verify supplier belongs to this company
    const { rows: supRows } = await query(
      `SELECT id FROM suppliers WHERE id = $1 AND company_id = $2`,
      [supplier_id, company_id]
    );
    if (supRows.length === 0) {
      return reply.status(404).send({ error: 'Supplier not found' });
    }

    const { rows } = await query(
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

    return reply.status(201).send(rows[0]);
  });

  // ── PATCH /api/procurement/purchases/:id/status ───────────────
  app.patch('/purchases/:id/status', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['pending', 'approved', 'received'] },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { status } = request.body;

    const { rows } = await query(
      `UPDATE raw_material_purchases
       SET status = $3
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [id, company_id, status]
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Purchase not found' });
    }

    return rows[0];
  });
}
