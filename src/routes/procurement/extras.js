import { query } from "../../db.js";

export default async function procurementExtrasRoutes(app) {

  // GET /api/procurement/supplier-categories — query supplier_tags table (backward compat route)
  app.get("/supplier-categories", { preHandler: [app.authenticate] }, async (request) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT id, name, code, color, is_active FROM supplier_tags WHERE company_id = $1 ORDER BY name`,
      [company_id]
    );
    // If no tags yet, return sensible defaults so UI isn't empty
    if (rows.length === 0) {
      return [
        { id: 'certification',    name: 'Certification',           code: 'certification',    color: '#6366f1', is_active: true },
        { id: 'diesel',           name: 'Diesel',                  code: 'diesel',           color: '#f59e0b', is_active: true },
        { id: 'local_logistics',  name: 'Local Logistics Partner', code: 'local_logistics',  color: '#10b981', is_active: true },
        { id: 'packing',          name: 'Packing',                 code: 'packing',          color: '#8b5cf6', is_active: true },
        { id: 'packing_materials',name: 'Packing Materials',       code: 'packing_materials',color: '#ec4899', is_active: true },
        { id: 'raw_material',     name: 'Raw Material',            code: 'raw_material',     color: '#ef4444', is_active: true },
        { id: 'service_provider', name: 'Service Provider',        code: 'service_provider', color: '#14b8a6', is_active: true },
        { id: 'shipping_company', name: 'Shipping Company',        code: 'shipping_company', color: '#3b82f6', is_active: true },
        { id: 'spare_parts',      name: 'Spare Parts',             code: 'spare_parts',      color: '#f97316', is_active: true },
      ];
    }
    return rows;
  });

  // GET /api/procurement/supplier-tags — same data, separate route
  app.get("/supplier-tags", { preHandler: [app.authenticate] }, async (request) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT id, name, code, color, is_active, created_at FROM supplier_tags WHERE company_id = $1 ORDER BY name`,
      [company_id]
    );
    return { data: rows };
  });

  // POST /api/procurement/supplier-tags
  app.post("/supplier-tags", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { name, code: codeRaw, color } = request.body ?? {};
    if (!name) return reply.status(400).send({ error: "name is required" });
    const code = codeRaw
      ? codeRaw.toLowerCase().replace(/\s+/g, '_')
      : name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    const { rows } = await query(
      `INSERT INTO supplier_tags (company_id, name, code, color, is_active)
       VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (company_id, code) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color
       RETURNING *`,
      [company_id, name, code, color ?? '#6366f1']
    );
    return reply.status(201).send(rows[0]);
  });

  // PATCH /api/procurement/supplier-tags/:id
  app.patch("/supplier-tags/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { name, code: codeRaw, color, is_active } = request.body ?? {};

    const updates = [];
    const params = [company_id, id];
    let p = 3;
    const set = (col, val) => { updates.push(`${col} = $${p++}`); params.push(val); };

    if (name !== undefined) set('name', name);
    if (codeRaw !== undefined) set('code', codeRaw.toLowerCase().replace(/\s+/g, '_'));
    if (color !== undefined) set('color', color);
    if (is_active !== undefined) set('is_active', is_active);

    if (!updates.length) return reply.status(400).send({ error: 'No fields to update' });

    const { rows } = await query(
      `UPDATE supplier_tags SET ${updates.join(', ')} WHERE company_id = $1 AND id = $2 RETURNING *`,
      params
    );
    if (!rows.length) return reply.status(404).send({ error: 'Tag not found' });
    return rows[0];
  });

  // DELETE /api/procurement/supplier-tags/:id — soft delete
  app.delete("/supplier-tags/:id", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { rows } = await query(
      `UPDATE supplier_tags SET is_active = false WHERE company_id = $1 AND id = $2 RETURNING *`,
      [company_id, id]
    );
    if (!rows.length) return reply.status(404).send({ error: 'Tag not found' });
    return rows[0];
  });

  // GET /api/procurement/supplier-requests
  app.get("/supplier-requests", { preHandler: [app.authenticate] }, async (request) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT * FROM supplier_requests WHERE company_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [company_id]
    );
    return { data: rows };
  });

  // POST /api/procurement/supplier-requests — submit new supplier for CEO approval
  app.post("/supplier-requests", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, id: user_id } = request.user;
    const { name, contact_person, phone, email, address, currency, bank_name,
            bank_account_number, iban, swift_code, services_provided, notes, price_per_service, selected_category_ids } = request.body;
    if (!name) return reply.status(400).send({ error: "name is required" });
    const { rows } = await query(
      `INSERT INTO supplier_requests
         (company_id, name, contact_person, phone, email, address, currency,
          bank_name, bank_account_number, iban, swift_code, services_provided, notes, price_per_service, requested_by, selected_category_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [company_id, name, contact_person ?? null, phone ?? null, email ?? null,
       address ?? null, currency ?? 'SAR', bank_name ?? null,
       bank_account_number ?? null, iban ?? null, swift_code ?? null,
       services_provided ?? null, notes ?? null, price_per_service ?? null, user_id,
       Array.isArray(selected_category_ids) ? selected_category_ids : []]
    );
    return reply.status(201).send(rows[0]);
  });

  // PATCH /api/procurement/supplier-requests/:id/approve — CEO approves, adds supplier
  app.patch("/supplier-requests/:id/approve", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, id: user_id } = request.user;
    const { id } = request.params;
    const { rows: reqRows } = await query(
      `UPDATE supplier_requests SET status='approved', reviewed_by=$1, reviewed_at=now(), updated_at=now()
       WHERE id=$2 AND company_id=$3 RETURNING *`,
      [user_id, id, company_id]
    );
    if (reqRows.length === 0) return reply.status(404).send({ error: "Request not found" });
    const sr = reqRows[0];
    // Create supplier record
    const approvedCategory = Array.isArray(sr.selected_category_ids) && sr.selected_category_ids.length > 0
      ? sr.selected_category_ids[0]
      : 'service_provider';
    const { rows: suppRows } = await query(
      `INSERT INTO suppliers (company_id, name, contact_name, contact_phone, email, address,
         currency, bank_name, bank_account_number, iban, swift_code, services_provided, is_active, category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13)
       ON CONFLICT DO NOTHING RETURNING id`,
      [company_id, sr.name, sr.contact_person, sr.phone, sr.email, sr.address,
       sr.currency, sr.bank_name, sr.bank_account_number, sr.iban, sr.swift_code, sr.services_provided, approvedCategory]
    );
    return { supplier_request: sr, supplier_id: suppRows[0]?.id ?? null };
  });

  // PATCH /api/procurement/supplier-requests/:id/reject
  app.patch("/supplier-requests/:id/reject", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, id: user_id } = request.user;
    const { id } = request.params;
    const { rows } = await query(
      `UPDATE supplier_requests SET status='rejected', reviewed_by=$1, reviewed_at=now(), updated_at=now()
       WHERE id=$2 AND company_id=$3 RETURNING *`,
      [user_id, id, company_id]
    );
    if (rows.length === 0) return reply.status(404).send({ error: "Request not found" });
    return rows[0];
  });

  // GET /api/procurement/price-change-requests
  // Returns pending price-change requests with supplier name/code embedded.
  app.get("/price-change-requests", { preHandler: [app.authenticate] }, async (request) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT pcr.*,
              json_build_object(
                'name', s.name,
                'supplier_code', COALESCE(s.supplier_code, '')
              ) AS suppliers
         FROM price_change_requests pcr
         LEFT JOIN suppliers s ON s.id = pcr.supplier_id
        WHERE pcr.company_id = $1
        ORDER BY pcr.requested_at DESC`,
      [company_id]
    );
    return rows;
  });

  // POST /api/procurement/price-change-requests
  // Create a new price change request.
  app.post("/price-change-requests", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const {
      supplier_id, current_price, requested_price, currency, justification,
    } = request.body ?? {};

    if (!supplier_id || !requested_price) {
      return reply.status(400).send({ error: "supplier_id and requested_price are required" });
    }

    const { rows } = await query(
      `INSERT INTO price_change_requests
         (company_id, supplier_id, current_price, requested_price,
          currency, justification, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [company_id, supplier_id, current_price ?? null, requested_price,
       currency ?? 'SAR', justification ?? null, user_id]
    );
    return reply.status(201).send(rows[0]);
  });

  // POST /api/procurement/price-change-requests/:id/approve
  // Applies the new price to suppliers.current_price and marks the request approved.
  app.post("/price-change-requests/:id/approve", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;

    const { rows: pcrRows } = await query(
      `SELECT supplier_id, requested_price, status FROM price_change_requests
        WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (!pcrRows.length) return reply.status(404).send({ error: "Request not found" });
    if (pcrRows[0].status !== 'pending') {
      return reply.status(400).send({ error: `Cannot approve from status '${pcrRows[0].status}'` });
    }

    const { supplier_id, requested_price } = pcrRows[0];

    const { rows } = await query(
      `UPDATE price_change_requests
         SET status='approved', reviewed_by=$1, reviewed_at=now(), updated_at=now()
       WHERE id=$2 AND company_id=$3 RETURNING *`,
      [user_id, id, company_id]
    );

    // Push the new price onto the supplier. Done after the PCR update so a
    // supplier update failure still leaves the request marked approved (the
    // ledger of decisions is the source of truth).
    await query(
      `UPDATE suppliers SET current_price=$1, updated_at=now()
        WHERE id=$2 AND company_id=$3`,
      [requested_price, supplier_id, company_id]
    );

    return rows[0];
  });

  // PATCH /api/procurement/price-change-requests/:id/reject
  app.patch("/price-change-requests/:id/reject", { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;
    const { reason } = request.body ?? {};

    const { rows } = await query(
      `UPDATE price_change_requests
         SET status='rejected', reviewed_by=$1, reviewed_at=now(),
             rejection_reason=$2, updated_at=now()
       WHERE id=$3 AND company_id=$4 RETURNING *`,
      [user_id, reason ?? null, id, company_id]
    );
    if (!rows.length) return reply.status(404).send({ error: "Request not found" });
    return rows[0];
  });

  // GET /api/procurement/llp-pricing — stub (no llp_pricing table yet)
  app.get("/llp-pricing", { preHandler: [app.authenticate] }, async () => []);

  // POST /api/procurement/llp-pricing — stub
  app.post("/llp-pricing", { preHandler: [app.authenticate] }, async (_request, reply) => {
    return reply.status(501).send({ error: "LLP pricing not yet configured" });
  });

  // PATCH /api/procurement/llp-pricing/:id — stub
  app.patch("/llp-pricing/:id", { preHandler: [app.authenticate] }, async (_request, reply) => {
    return reply.status(501).send({ error: "LLP pricing not yet configured" });
  });

  // GET /api/procurement/suppliers-with-categories
  // Uses supplier_tag_mapping + supplier_tags for tag-aware data, falls back to legacy category column
  app.get("/suppliers-with-categories", { preHandler: [app.authenticate] }, async (request) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT s.id, s.name,
              s.category,
              s.contact_name AS contact_person,
              s.contact_phone AS phone,
              s.email,
              s.address,
              s.bank_name,
              s.bank_account_number,
              s.iban,
              s.swift_code,
              s.services_provided,
              s.current_price, s.currency, s.supplier_code,
              CASE WHEN s.is_active THEN 'active' ELSE 'inactive' END AS status,
              s.payment_term_type, s.credit_days,
              COALESCE(
                json_agg(
                  json_build_object('id', t.id, 'name', t.name, 'code', t.code, 'color', t.color)
                ) FILTER (WHERE t.id IS NOT NULL), '[]'
              ) AS tags,
              COALESCE(
                json_agg(
                  json_build_object('id', t.id, 'name', t.name, 'code', t.code, 'color', t.color)
                ) FILTER (WHERE t.id IS NOT NULL),
                CASE WHEN s.category IS NOT NULL
                  THEN json_build_array(json_build_object(
                    'id', s.category,
                    'name', initcap(replace(s.category, '_', ' ')),
                    'code', s.category
                  ))
                  ELSE '[]'::json
                END
              ) AS categories
       FROM suppliers s
       LEFT JOIN supplier_tag_mapping stm ON stm.supplier_id = s.id
       LEFT JOIN supplier_tags t ON t.id = stm.tag_id AND t.company_id = s.company_id
       WHERE s.company_id = $1
       GROUP BY s.id
       ORDER BY s.name ASC`,
      [company_id]
    );
    return rows;
  });

  // GET /api/procurement/suppliers/by-category?category_code=X&status=active
  // Uses tag mapping when possible, falls back to legacy category column
  app.get("/suppliers/by-category", { preHandler: [app.authenticate] }, async (request) => {
    const { company_id } = request.user;
    const { category_code, status } = request.query;

    if (!category_code) {
      const conditions = ['s.company_id = $1'];
      const params = [company_id];
      if (status === 'active') conditions.push('s.is_active = true');
      const { rows } = await query(
        `SELECT s.id, s.name, s.category, s.contact_name AS contact_person, s.contact_phone AS phone,
                s.email, s.address, s.services_provided, s.current_price, s.currency, s.supplier_code,
                CASE WHEN s.is_active THEN 'active' ELSE 'inactive' END AS status
         FROM suppliers s WHERE ${conditions.join(' AND ')} ORDER BY s.name ASC`,
        params
      );
      return rows;
    }

    // Normalize aliases
    const categoryAliases = {
      raw_material: ['raw_material', 'raw_scrap'],
      raw_scrap: ['raw_material', 'raw_scrap'],
      local_logistics: ['local_logistics', 'logistics'],
      logistics: ['local_logistics', 'logistics'],
      shipping_company: ['shipping_company', 'shipping_services'],
      shipping_services: ['shipping_company', 'shipping_services'],
    };
    const accepted = categoryAliases[category_code] ?? [category_code];

    const statusClause = status === 'active' ? 'AND s.is_active = true' : '';

    // Try tag mapping first, union with legacy category column
    const { rows } = await query(
      `SELECT DISTINCT s.id, s.name, s.category, s.contact_name AS contact_person, s.contact_phone AS phone,
              s.email, s.address, s.services_provided, s.current_price, s.currency, s.supplier_code,
              CASE WHEN s.is_active THEN 'active' ELSE 'inactive' END AS status
       FROM suppliers s
       WHERE s.company_id = $1
         AND (
           EXISTS (
             SELECT 1 FROM supplier_tag_mapping stm
             JOIN supplier_tags t ON t.id = stm.tag_id
             WHERE stm.supplier_id = s.id AND t.code = ANY($2::text[])
           )
           OR s.category = ANY($2::text[])
         )
         ${statusClause}
       ORDER BY s.name ASC`,
      [company_id, accepted]
    );
    return rows;
  });

}
