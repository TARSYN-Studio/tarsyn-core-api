import { pool, withTransaction } from '../../db.js';

// Inventory deltas produced by a stage1 batch
function stage1Deltas(b) {
  return [
    { item_type: 'raw_scrap',    change_mt: -(b.raw_scrap_input       ?? 0) },
    { item_type: 'pure_rubber',  change_mt:  (b.pure_material_output  ?? 0) },
    { item_type: 'copper',       change_mt:  (b.copper_output         ?? 0) },
    { item_type: 'waste',        change_mt:  (b.waste_output          ?? 0) },
  ].filter(d => d.change_mt !== 0);
}

// Inventory deltas produced by a stage2 batch
// quantity     = pure_rubber consumed from stock this batch
// wip_opening  = WIP brought in from previous day
// wip_closing  = WIP carried forward
// finished_goods = output to finished goods stock
// waste_generated = waste created
function stage2Deltas(b) {
  const wipNet = (b.wip_closing ?? 0) - (b.wip_opening ?? 0);
  return [
    { item_type: 'pure_rubber',    change_mt: -(b.quantity         ?? 0) },
    { item_type: 'wip',            change_mt:   wipNet                   },
    { item_type: 'finished_goods', change_mt:  (b.finished_goods   ?? 0) },
    { item_type: 'waste',          change_mt:  (b.waste_generated  ?? 0) },
  ].filter(d => d.change_mt !== 0);
}

export default async function batchesRoutes(app) {

  // ── GET /api/production/batches ───────────────────────────────
  app.get('/batches', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          stage:    { type: 'string', enum: ['stage1', 'stage2'] },
          order_id: { type: 'string' },
          from:     { type: 'string' },
          to:       { type: 'string' },
          limit:    { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset:   { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { stage, order_id, from, to, limit, offset } = request.query;

    const conditions = ['company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (stage)    { conditions.push(`stage = $${p++}`);                params.push(stage);    }
    if (order_id) { conditions.push(`production_order_id = $${p++}`);  params.push(order_id); }
    if (from)     { conditions.push(`production_date >= $${p++}`);     params.push(from);     }
    if (to)       { conditions.push(`production_date <= $${p++}`);     params.push(to);       }

    params.push(limit, offset);

    const { rows } = await pool.query(
      `SELECT * FROM production_batches
       WHERE ${conditions.join(' AND ')}
       ORDER BY production_date DESC, created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    return { data: rows, limit, offset };
  });

  // ── POST /api/production/batches ──────────────────────────────
  app.post('/batches', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['stage', 'production_date', 'quantity'],
        properties: {
          stage:               { type: 'string', enum: ['stage1', 'stage2'] },
          production_order_id: { type: 'string' },
          production_date:     { type: 'string' },
          quantity:            { type: 'number', exclusiveMinimum: 0 },
          // Stage 1
          raw_scrap_input:      { type: 'number', minimum: 0 },
          pure_material_output: { type: 'number', minimum: 0 },
          copper_output:        { type: 'number', minimum: 0 },
          waste_output:         { type: 'number', minimum: 0 },
          // Stage 2
          wip_opening:    { type: 'number', minimum: 0 },
          finished_goods: { type: 'number', minimum: 0 },
          wip_closing:    { type: 'number', minimum: 0 },
          waste_generated:{ type: 'number', minimum: 0 },
          // Common
          operator_count: { type: 'integer', minimum: 0 },
          notes:          { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id, sub: created_by } = request.user;
    const b = request.body;

    // Stage-specific validation
    if (b.stage === 'stage1' && !b.raw_scrap_input) {
      return reply.status(400).send({ error: 'Stage 1 requires raw_scrap_input' });
    }
    if (b.stage === 'stage2' && b.finished_goods === undefined) {
      return reply.status(400).send({ error: 'Stage 2 requires finished_goods' });
    }

    const deltas = b.stage === 'stage1' ? stage1Deltas(b) : stage2Deltas(b);

    const result = await withTransaction(async (client) => {
      // 1. Insert batch
      const { rows } = await client.query(
        `INSERT INTO production_batches
           (company_id, stage, production_order_id, production_date, quantity,
            raw_scrap_input, pure_material_output, copper_output, waste_output,
            wip_opening, finished_goods, wip_closing, waste_generated,
            operator_count, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [
          company_id, b.stage, b.production_order_id ?? null, b.production_date,
          b.quantity,
          b.raw_scrap_input ?? null, b.pure_material_output ?? null,
          b.copper_output   ?? null, b.waste_output         ?? null,
          b.wip_opening     ?? null, b.finished_goods       ?? null,
          b.wip_closing     ?? null, b.waste_generated      ?? null,
          b.operator_count  ?? null, b.notes                ?? null,
          created_by,
        ]
      );
      const batch = rows[0];

      // 2. Apply each inventory delta
      const updatedItems = [];
      for (const delta of deltas) {
        const { rows: updated } = await client.query(
          `UPDATE inventory_items
           SET quantity_mt = quantity_mt + $1, last_updated = now()
           WHERE company_id = $2 AND item_type = $3
           RETURNING item_type, quantity_mt`,
          [delta.change_mt, company_id, delta.item_type]
        );
        if (updated.length > 0) updatedItems.push(updated[0]);

        // 3. Write log row
        await client.query(
          `INSERT INTO inventory_logs
             (company_id, item_type, change_mt, reason, reference_id, reference_type, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            company_id, delta.item_type, delta.change_mt,
            `${b.stage} batch report — ${b.production_date}`,
            batch.id, 'production_batch', created_by,
          ]
        );
      }

      return { batch, inventory: updatedItems };
    });

    return reply.status(201).send(result);
  });
}
