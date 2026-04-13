import { query } from "../../db.js";

export default async function procurementExtrasRoutes(app) {

  // GET /api/procurement/supplier-categories — returns [{id,name,code}]
  app.get("/supplier-categories", { preHandler: [app.authenticate] }, async (request) => {
    const { company_id } = request.user;
    const { is_active } = request.query;
    let sql = `SELECT DISTINCT category AS id, category AS name, category AS code
               FROM suppliers WHERE company_id = $1 AND category IS NOT NULL`;
    const params = [company_id];
    if (is_active === "true") sql += " AND is_active = true";
    sql += " ORDER BY category";
    const { rows } = await query(sql, params);
    return rows;
  });

  // GET /api/procurement/supplier-requests — stub
  app.get("/supplier-requests", { preHandler: [app.authenticate] }, async () => []);

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
              contact_name AS contact_person,
              contact_phone AS phone,
              NULL::text AS email,
              NULL::text AS address,
              current_price, currency, supplier_code,
              CASE WHEN is_active THEN 'active' ELSE 'inactive' END AS status,
              payment_term_type, credit_days,
              CASE WHEN category IS NOT NULL
                THEN json_build_array(json_build_object('id', category, 'name', category, 'code', category))
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
    if (category_code) { conditions.push(`category = $${p++}`); params.push(category_code); }
    if (status === "active") conditions.push("is_active = true");
    const { rows } = await query(
      `SELECT id, name,
              contact_name AS contact_person,
              contact_phone AS phone,
              current_price, currency, supplier_code,
              CASE WHEN is_active THEN 'active' ELSE 'inactive' END AS status
       FROM suppliers WHERE ${conditions.join(" AND ")} ORDER BY name ASC`,
      params
    );
    return rows;
  });

}
