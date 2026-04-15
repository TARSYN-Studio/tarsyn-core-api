import { query } from "../../db.js";

export default async function procurementExtrasRoutes(app) {

  // GET /api/procurement/supplier-categories — professional category list
  app.get("/supplier-categories", { preHandler: [app.authenticate] }, async (_request, _reply) => {
    return [
      { id: 'certification',    name: 'Certification',           code: 'certification' },
      { id: 'diesel',           name: 'Diesel',                  code: 'diesel' },
      { id: 'local_logistics',  name: 'Local Logistics Partner', code: 'local_logistics' },
      { id: 'packing',          name: 'Packing',                 code: 'packing' },
      { id: 'packing_materials',name: 'Packing Materials',       code: 'packing_materials' },
      { id: 'raw_material',     name: 'Raw Material',            code: 'raw_material' },
      { id: 'service_provider', name: 'Service Provider',        code: 'service_provider' },
      { id: 'shipping_company', name: 'Shipping Company',        code: 'shipping_company' },
      { id: 'spare_parts',      name: 'Spare Parts',             code: 'spare_parts' },
    ];
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

  // GET /api/procurement/price-change-requests — stub
  app.get("/price-change-requests", { preHandler: [app.authenticate] }, async () => []);

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
  app.get("/suppliers-with-categories", { preHandler: [app.authenticate] }, async (request) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT id, name,
              category,
              contact_name AS contact_person,
              contact_phone AS phone,
              email,
              address,
              bank_name,
              bank_account_number,
              iban,
              swift_code,
              services_provided,
              current_price, currency, supplier_code,
              CASE WHEN is_active THEN 'active' ELSE 'inactive' END AS status,
              payment_term_type, credit_days,
              CASE WHEN category IS NOT NULL
                THEN json_build_array(json_build_object(
                  'id', category,
                  'name', initcap(replace(category, '_', ' ')),
                  'code', category
                ))
                ELSE '[]'::json
              END AS categories
       FROM suppliers WHERE company_id = $1 ORDER BY name ASC`,
      [company_id]
    );
    return rows;
  });

  // GET /api/procurement/suppliers/by-category?category_code=X&status=active
  app.get("/suppliers/by-category", { preHandler: [app.authenticate] }, async (request) => {
    const { company_id } = request.user;
    const { category_code, status } = request.query;
    const params = [company_id];
    const conditions = ["company_id = $1"];
    let p = 2;
    if (category_code) {
      const categoryAliases = {
        raw_material: ['raw_material', 'raw_scrap'],
        raw_scrap: ['raw_material', 'raw_scrap'],
        local_logistics: ['local_logistics', 'logistics'],
        logistics: ['local_logistics', 'logistics'],
        shipping_company: ['shipping_company', 'shipping_services'],
        shipping_services: ['shipping_company', 'shipping_services'],
      };
      const accepted = categoryAliases[category_code] ?? [category_code];
      if (accepted.length === 1) {
        conditions.push(`category = $${p++}`); params.push(accepted[0]);
      } else {
        conditions.push(`category = ANY($${p++}::text[])`); params.push(accepted);
      }
    }
    if (status === "active") conditions.push("is_active = true");
    const { rows } = await query(
      `SELECT id, name,
              category,
              contact_name AS contact_person,
              contact_phone AS phone,
              email,
              address,
              services_provided,
              current_price, currency, supplier_code,
              CASE WHEN is_active THEN 'active' ELSE 'inactive' END AS status
       FROM suppliers WHERE ${conditions.join(" AND ")} ORDER BY name ASC`,
      params
    );
    return rows;
  });

}

