import { query } from '../../db.js';

export default async function procurementExtrasRoutes(app) {

  // GET /api/procurement/supplier-categories
  app.get('/supplier-categories', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT DISTINCT category FROM suppliers
       WHERE company_id = $1 AND category IS NOT NULL ORDER BY category`,
      [company_id]
    );
    return { data: rows.map(r => r.category) };
  });

  // GET /api/procurement/supplier-requests — placeholder for future feature
  app.get('/supplier-requests', { preHandler: [app.authenticate] }, async (_request, reply) => {
    return { data: [] };
  });

  // GET /api/procurement/llp-pricing — LLP (Logistics Logistics Provider) pricing
  app.get('/llp-pricing', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    // Sourced from company_settings where key starts with 'llp_'
    const { rows } = await query(
      `SELECT key, value FROM company_settings
       WHERE company_id = $1 AND key LIKE 'llp_%' ORDER BY key`,
      [company_id]
    );
    const result = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  });
}
