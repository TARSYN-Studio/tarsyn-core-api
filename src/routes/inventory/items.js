import { query, withTransaction } from '../../db.js';

const VALID_ITEM_TYPES = ['raw_scrap','pure_rubber','copper','waste','finished_goods','wip'];

export default async function inventoryRoutes(app) {

  // ── GET /api/inventory/items ──────────────────────────────────
  app.get('/items', {
    preHandler: [app.authenticate],
  }, async (request, _reply) => {
    const { company_id } = request.user;

    const { rows } = await query(
      `SELECT item_type, quantity_mt, last_updated
       FROM inventory_items
       WHERE company_id = $1
       ORDER BY item_type`,
      [company_id]
    );

    return { data: rows };
  });

  // ── GET /api/inventory/logs ───────────────────────────────────
  app.get('/logs', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          item_type:      { type: 'string' },
          reference_type: { type: 'string' },
          from:           { type: 'string' },
          to:             { type: 'string' },
          limit:          { type: 'integer', minimum: 1, maximum: 200, default: 100 },
          offset:         { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, _reply) => {
    const { company_id } = request.user;
    const { item_type, reference_type, from, to, limit, offset } = request.query;

    const conditions = ['company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (item_type)      { conditions.push(`item_type = $${p++}`);        params.push(item_type);      }
    if (reference_type) { conditions.push(`reference_type = $${p++}`);   params.push(reference_type); }
    if (from)           { conditions.push(`created_at >= $${p++}`);      params.push(from);           }
    if (to)             { conditions.push(`created_at <= $${p++}`);      params.push(to);             }

    params.push(limit, offset);

    const { rows } = await query(
      `SELECT id, item_type, change_mt, reason, reference_id,
              reference_type, created_at, created_by
       FROM inventory_logs
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    return { data: rows, limit, offset };
  });

  // ── POST /api/inventory/adjustment ───────────────────────────
  // Handles opening balances (Excel import) and manual corrections.
  // Always writes to inventory_items + inventory_logs in one transaction.
  app.post('/adjustment', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['item_type', 'change_mt', 'reason'],
        properties: {
          item_type:      { type: 'string', enum: VALID_ITEM_TYPES },
          change_mt:      { type: 'number' },   // positive = add, negative = subtract
          reason:         { type: 'string', minLength: 1 },
          reference_type: { type: 'string', default: 'manual_adjustment' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: created_by } = request.user;
    const {
      item_type, change_mt, reason,
      reference_type = 'manual_adjustment',
    } = request.body;

    if (change_mt === 0) {
      return reply.status(400).send({ error: 'change_mt cannot be zero' });
    }

    const result = await withTransaction(async (client) => {
      // Update inventory snapshot
      const { rows: updated } = await client.query(
        `UPDATE inventory_items
         SET quantity_mt = quantity_mt + $1, last_updated = now()
         WHERE company_id = $2 AND item_type = $3
         RETURNING item_type, quantity_mt, last_updated`,
        [change_mt, company_id, item_type]
      );

      if (updated.length === 0) {
        // Row doesn't exist yet — insert it
        const { rows: inserted } = await client.query(
          `INSERT INTO inventory_items (company_id, item_type, quantity_mt)
           VALUES ($1, $2, $3)
           RETURNING item_type, quantity_mt, last_updated`,
          [company_id, item_type, change_mt]
        );
        updated.push(inserted[0]);
      }

      // Write log
      const { rows: logRow } = await client.query(
        `INSERT INTO inventory_logs
           (company_id, item_type, change_mt, reason, reference_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, item_type, change_mt, reason, reference_type, created_at`,
        [company_id, item_type, change_mt, reason, reference_type, created_by]
      );

      return { item: updated[0], log: logRow[0] };
    });

    return reply.status(201).send(result);
  });
}
