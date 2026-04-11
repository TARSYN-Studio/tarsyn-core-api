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

}
