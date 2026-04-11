import { query } from '../db.js';

export default async function usersRoutes(app) {

  // ── GET /api/users/me/permissions ─────────────────────────────
  // Query: ?module=production
  // Returns the access_level for the calling user on a given module.
  // Admins (role=admin) short-circuit to approve_l3 — no DB lookup needed.
  app.get('/users/me/permissions', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        required: ['module'],
        properties: {
          module: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, _reply) => {
    const { sub: user_id, company_id, role } = request.user;
    const { module: moduleName } = request.query;

    // Admins have unrestricted access — skip the DB lookup
    if (role === 'admin' || role === 'ceo') {
      return { access_level: 'approve_l3' };
    }

    const { rows } = await query(
      `SELECT access_level
       FROM module_permissions
       WHERE user_id = $1 AND company_id = $2 AND module = $3`,
      [user_id, company_id, moduleName]
    );

    return { access_level: rows[0]?.access_level ?? 'none' };
  });
}
