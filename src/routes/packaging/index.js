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

  // ── GET /api/packaging/purchase-requests ────────────────────────
  // Returns the request list (joined with requester name) — newest first.
  app.get('/purchase-requests', { preHandler: [app.authenticate] }, async (request) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT ppr.*,
              json_build_object('full_name', u.full_name) AS profiles
         FROM packaging_purchase_requests ppr
         LEFT JOIN users u ON u.id = ppr.requester_id
        WHERE ppr.company_id = $1
        ORDER BY ppr.created_at DESC`,
      [company_id]
    );
    return { data: rows };
  });

  // ── POST /api/packaging/purchase-requests ───────────────────────
  // Create a new request (status=submitted). Auto-generates request_number
  // like PR-YYYY-NNNN scoped by company.
  app.post('/purchase-requests', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: requester_id } = request.user;
    const {
      item_id, item_name, category, qty_requested,
      unit_of_measure, needed_by_date, reason_for_request,
    } = request.body ?? {};

    if (!item_name || !qty_requested) {
      return reply.status(400).send({ error: 'item_name and qty_requested are required' });
    }

    const year = new Date().getFullYear();
    const result = await withTransaction(async (client) => {
      const { rows: seqRows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM packaging_purchase_requests
          WHERE company_id = $1 AND request_number LIKE $2`,
        [company_id, `PR-${year}-%`]
      );
      const request_number = `PR-${year}-${String(seqRows[0].n + 1).padStart(4, '0')}`;

      const { rows } = await client.query(
        `INSERT INTO packaging_purchase_requests
           (company_id, request_number, item_id, item_name, category,
            qty_requested, unit_of_measure, needed_by_date, reason_for_request,
            status, requester_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'submitted',$10)
         RETURNING *`,
        [company_id, request_number, item_id ?? null, item_name, category ?? null,
         qty_requested, unit_of_measure ?? null, needed_by_date ?? null,
         reason_for_request ?? null, requester_id]
      );
      return rows[0];
    });

    return reply.status(201).send(result);
  });

  // ── POST /api/packaging/purchase-requests/:id/approve ──────────
  // Two-stage approval: body { level: 'manager' | 'finance' }.
  //   manager  : submitted       → manager_approved
  //   finance  : manager_approved → approved
  app.post('/purchase-requests/:id/approve', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;
    const { level } = request.body ?? {};

    if (level !== 'manager' && level !== 'finance') {
      return reply.status(400).send({ error: "level must be 'manager' or 'finance'" });
    }

    const { rows: existing } = await query(
      `SELECT status FROM packaging_purchase_requests WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (!existing.length) return reply.status(404).send({ error: 'Request not found' });

    const cur = existing[0].status;
    let nextStatus, updateCol, updateAtCol;
    if (level === 'manager') {
      if (cur !== 'submitted') {
        return reply.status(400).send({ error: `Cannot manager-approve from status '${cur}'` });
      }
      nextStatus = 'manager_approved';
      updateCol = 'manager_approved_by';
      updateAtCol = 'manager_approved_at';
    } else {
      if (cur !== 'manager_approved') {
        return reply.status(400).send({ error: `Cannot finance-approve from status '${cur}'` });
      }
      nextStatus = 'approved';
      updateCol = 'finance_approved_by';
      updateAtCol = 'finance_approved_at';
    }

    const { rows } = await query(
      `UPDATE packaging_purchase_requests
         SET status = $1, ${updateCol} = $2, ${updateAtCol} = now(), updated_at = now()
       WHERE id = $3 AND company_id = $4 RETURNING *`,
      [nextStatus, user_id, id, company_id]
    );
    return rows[0];
  });

  // ── PATCH /api/packaging/purchase-requests/:id/reject ──────────
  app.patch('/purchase-requests/:id/reject', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;
    const { reason } = request.body ?? {};

    const { rows } = await query(
      `UPDATE packaging_purchase_requests
         SET status='rejected', rejected_by=$1, rejected_at=now(),
             rejection_reason=$2, updated_at=now()
       WHERE id=$3 AND company_id=$4 RETURNING *`,
      [user_id, reason ?? null, id, company_id]
    );
    if (!rows.length) return reply.status(404).send({ error: 'Request not found' });
    return rows[0];
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
