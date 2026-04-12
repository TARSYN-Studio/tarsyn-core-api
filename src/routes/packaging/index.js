import { query, withTransaction } from '../../db.js';

export default async function packagingRoutes(app) {

  // GET /api/packaging/items
  app.get('/items', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT id, item_name, item_code, unit, quantity, reorder_level, unit_cost, is_active, created_at
       FROM packaging_items WHERE company_id = $1 AND is_active = true ORDER BY item_name`,
      [company_id]
    );
    return { data: rows };
  });

  // POST /api/packaging/items
  app.post('/items', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { item_name, item_code, unit, quantity, reorder_level, unit_cost } = request.body;
    const { rows } = await query(
      `INSERT INTO packaging_items (company_id, item_name, item_code, unit, quantity, reorder_level, unit_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (company_id, item_name) DO UPDATE
         SET quantity = packaging_items.quantity + EXCLUDED.quantity, unit_cost = EXCLUDED.unit_cost
       RETURNING *`,
      [company_id, item_name, item_code ?? null, unit ?? 'pcs',
       quantity ?? 0, reorder_level ?? 0, unit_cost ?? 0]
    );
    return reply.status(201).send(rows[0]);
  });

  // PATCH /api/packaging/items/:id
  app.patch('/items/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { item_name, item_code, unit, reorder_level, unit_cost, is_active } = request.body;

    const sets = [];
    const params = [id, company_id];
    let p = 3;
    if (item_name    !== undefined) { sets.push(`item_name = $${p++}`);    params.push(item_name); }
    if (item_code    !== undefined) { sets.push(`item_code = $${p++}`);    params.push(item_code); }
    if (unit         !== undefined) { sets.push(`unit = $${p++}`);         params.push(unit); }
    if (reorder_level!== undefined) { sets.push(`reorder_level = $${p++}`);params.push(reorder_level); }
    if (unit_cost    !== undefined) { sets.push(`unit_cost = $${p++}`);    params.push(unit_cost); }
    if (is_active    !== undefined) { sets.push(`is_active = $${p++}`);    params.push(is_active); }
    if (!sets.length) return reply.status(400).send({ error: 'No fields to update' });

    const { rows } = await query(
      `UPDATE packaging_items SET ${sets.join(', ')} WHERE id = $1 AND company_id = $2 RETURNING *`,
      params
    );
    if (!rows.length) return reply.status(404).send({ error: 'Item not found' });
    return rows[0];
  });

  // GET /api/packaging/logs
  app.get('/logs', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          from:    { type: 'string' },
          to:      { type: 'string' },
          limit:   { type: 'integer', minimum: 1, maximum: 200, default: 100 },
          offset:  { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { item_id, from, to, limit, offset } = request.query;

    const conditions = ['l.company_id = $1'];
    const params = [company_id];
    let p = 2;
    if (item_id) { conditions.push(`l.item_id = $${p++}`);     params.push(item_id); }
    if (from)    { conditions.push(`l.created_at >= $${p++}`); params.push(from);    }
    if (to)      { conditions.push(`l.created_at <= $${p++}`); params.push(to);      }
    params.push(limit, offset);

    const { rows } = await query(
      `SELECT l.id, l.item_id, pi.item_name, l.change_qty, l.reason,
              l.reference_id, l.reference_type, l.created_at,
              u.full_name AS created_by_name
       FROM packaging_logs l
       LEFT JOIN packaging_items pi ON pi.id = l.item_id
       LEFT JOIN users u ON u.id = l.created_by
       WHERE ${conditions.join(' AND ')}
       ORDER BY l.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );
    return { data: rows, limit, offset };
  });

  // POST /api/packaging/adjustment
  app.post('/adjustment', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: created_by } = request.user;
    const { item_id, change_qty, reason, reference_type } = request.body;

    if (!change_qty || change_qty === 0) {
      return reply.status(400).send({ error: 'change_qty cannot be zero' });
    }

    const result = await withTransaction(async (client) => {
      const { rows: updated } = await client.query(
        `UPDATE packaging_items SET quantity = quantity + $1
         WHERE id = $2 AND company_id = $3 RETURNING id, item_name, quantity`,
        [change_qty, item_id, company_id]
      );
      if (!updated.length) throw new Error('Item not found');

      const { rows: logRow } = await client.query(
        `INSERT INTO packaging_logs (company_id, item_id, change_qty, reason, reference_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, change_qty, created_at`,
        [company_id, item_id, change_qty, reason ?? null, reference_type ?? 'manual', created_by]
      );
      return { item: updated[0], log: logRow[0] };
    });

    return reply.status(201).send(result);
  });
}
