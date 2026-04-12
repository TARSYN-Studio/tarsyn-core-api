import { query } from '../../db.js';

export default async function productionInventoryRoutes(app) {

  // GET /api/production/inventory-items
  // Returns inventory snapshot (same as /api/inventory/items but under /production prefix)
  app.get('/inventory-items', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT item_type, quantity_mt, last_updated
       FROM inventory_items WHERE company_id = $1 ORDER BY item_type`,
      [company_id]
    );
    return { data: rows };
  });

  // POST /api/production/inventory-items — upsert an item balance
  app.post('/inventory-items', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { item_type, quantity_mt } = request.body;
    const { rows } = await query(
      `INSERT INTO inventory_items (company_id, item_type, quantity_mt)
       VALUES ($1,$2,$3)
       ON CONFLICT (company_id, item_type)
       DO UPDATE SET quantity_mt = EXCLUDED.quantity_mt, last_updated = now()
       RETURNING item_type, quantity_mt, last_updated`,
      [company_id, item_type, quantity_mt]
    );
    return reply.status(201).send(rows[0]);
  });

  // PATCH /api/production/inventory-items/:item_type
  app.patch('/inventory-items/:item_type', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { item_type } = request.params;
    const { quantity_mt } = request.body;
    const { rows } = await query(
      `UPDATE inventory_items SET quantity_mt = $1, last_updated = now()
       WHERE company_id = $2 AND item_type = $3
       RETURNING item_type, quantity_mt, last_updated`,
      [quantity_mt, company_id, item_type]
    );
    if (!rows.length) return reply.status(404).send({ error: 'Item not found' });
    return rows[0];
  });

  // GET /api/production/inventory-logs
  app.get('/inventory-logs', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          item_type:      { type: 'string' },
          reference_type: { type: 'string' },
          from:           { type: 'string' },
          to:             { type: 'string' },
          limit:          { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          offset:         { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { item_type, reference_type, from, to, limit, offset } = request.query;

    const conditions = ['company_id = $1'];
    const params = [company_id];
    let p = 2;
    if (item_type)      { conditions.push(`item_type = $${p++}`);      params.push(item_type); }
    if (reference_type) { conditions.push(`reference_type = $${p++}`); params.push(reference_type); }
    if (from)           { conditions.push(`created_at >= $${p++}`);    params.push(from); }
    if (to)             { conditions.push(`created_at <= $${p++}`);    params.push(to); }
    params.push(limit, offset);

    const { rows } = await query(
      `SELECT id, item_type, change_mt, reason, reference_id, reference_type, created_at, created_by
       FROM inventory_logs WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${p} OFFSET $${p + 1}`,
      params
    );
    return { data: rows, limit, offset };
  });

  // GET /api/production/inventory-logs/materials — aggregate by material type
  app.get('/inventory-logs/materials', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { from, to } = request.query;

    const conditions = ['company_id = $1'];
    const params = [company_id];
    let p = 2;
    if (from) { conditions.push(`created_at >= $${p++}`); params.push(from); }
    if (to)   { conditions.push(`created_at <= $${p++}`); params.push(to);   }

    const { rows } = await query(
      `SELECT item_type,
              COALESCE(SUM(change_mt) FILTER (WHERE change_mt > 0), 0) AS total_in,
              COALESCE(SUM(ABS(change_mt)) FILTER (WHERE change_mt < 0), 0) AS total_out,
              COALESCE(SUM(change_mt), 0) AS net_change
       FROM inventory_logs WHERE ${conditions.join(' AND ')}
       GROUP BY item_type ORDER BY item_type`,
      params
    );
    return { data: rows };
  });
}
