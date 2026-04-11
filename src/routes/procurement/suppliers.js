import { query } from '../../db.js';

export default async function suppliersRoutes(app) {

  // ── GET /api/procurement/suppliers ───────────────────────────
  app.get('/suppliers', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          is_active: { type: 'boolean' },
          category:  { type: 'string' },
          limit:     { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset:    { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, _reply) => {
    const { company_id } = request.user;
    const { is_active, category, limit, offset } = request.query;

    const conditions = ['company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (is_active !== undefined) { conditions.push(`is_active = $${p++}`); params.push(is_active); }
    if (category)                { conditions.push(`category  = $${p++}`); params.push(category);  }

    params.push(limit, offset);

    const { rows } = await query(
      `SELECT id, name, category, contact_name, contact_phone,
              payment_terms, is_active, created_at
       FROM suppliers
       WHERE ${conditions.join(' AND ')}
       ORDER BY name ASC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS total FROM suppliers WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2)
    );

    return { data: rows, total: parseInt(countRows[0].total, 10), limit, offset };
  });

  // ── POST /api/procurement/suppliers ──────────────────────────
  app.post('/suppliers', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name:          { type: 'string', minLength: 1 },
          category:      { type: 'string' },
          contact_name:  { type: 'string' },
          contact_phone: { type: 'string' },
          payment_terms: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { name, category, contact_name, contact_phone, payment_terms } = request.body;

    const { rows } = await query(
      `INSERT INTO suppliers
         (company_id, name, category, contact_name, contact_phone, payment_terms)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [company_id, name.trim(), category ?? null, contact_name ?? null,
       contact_phone ?? null, payment_terms ?? null]
    );

    return reply.status(201).send(rows[0]);
  });

  // ── GET /api/procurement/purchases ───────────────────────────
  app.get('/purchases', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          supplier_id:   { type: 'string' },
          status:        { type: 'string' },
          material_type: { type: 'string' },
          from:          { type: 'string' },
          to:            { type: 'string' },
          limit:         { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset:        { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, _reply) => {
    const { company_id } = request.user;
    const { supplier_id, status, material_type, from, to, limit, offset } = request.query;

    const conditions = ['p.company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (supplier_id)   { conditions.push(`p.supplier_id   = $${p++}`); params.push(supplier_id);   }
    if (status)        { conditions.push(`p.status        = $${p++}`); params.push(status);        }
    if (material_type) { conditions.push(`p.material_type = $${p++}`); params.push(material_type); }
    if (from)          { conditions.push(`p.purchase_date >= $${p++}`); params.push(from);         }
    if (to)            { conditions.push(`p.purchase_date <= $${p++}`); params.push(to);           }

    params.push(limit, offset);

    const { rows } = await query(
      `SELECT p.id, p.purchase_date, p.material_type, p.tonnage,
              p.purchase_amount, p.transport_cost, p.status,
              p.created_at, p.created_by,
              s.name AS supplier_name
       FROM raw_material_purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY p.purchase_date DESC, p.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS total FROM raw_material_purchases p
       WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2)
    );

    return { data: rows, total: parseInt(countRows[0].total, 10), limit, offset };
  });

  // ── POST /api/procurement/purchases ──────────────────────────
  app.post('/purchases', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['purchase_date', 'tonnage', 'purchase_amount'],
        properties: {
          supplier_id:     { type: 'string' },
          purchase_date:   { type: 'string' },
          material_type:   { type: 'string', default: 'raw_scrap' },
          tonnage:         { type: 'number', exclusiveMinimum: 0 },
          purchase_amount: { type: 'number', exclusiveMinimum: 0 },
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

    const { rows } = await query(
      `INSERT INTO raw_material_purchases
         (company_id, supplier_id, purchase_date, material_type,
          tonnage, purchase_amount, transport_cost, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [company_id, supplier_id ?? null, purchase_date, material_type,
       tonnage, purchase_amount, transport_cost, status, created_by]
    );

    return reply.status(201).send(rows[0]);
  });
}
