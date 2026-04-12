import { query } from '../../db.js';

export default async function auditRoutes(app) {

  // GET /api/audit/logs
  app.get('/logs', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          entity_type: { type: 'string' },
          entity_id:   { type: 'string' },
          action:      { type: 'string' },
          user_id:     { type: 'string' },
          from:        { type: 'string' },
          to:          { type: 'string' },
          limit:       { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          offset:      { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { entity_type, entity_id, action, user_id, from, to, limit, offset } = request.query;

    const conditions = ['a.company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (entity_type) { conditions.push(`a.entity_type = $${p++}`); params.push(entity_type); }
    if (entity_id)   { conditions.push(`a.entity_id = $${p++}`);   params.push(entity_id);   }
    if (action)      { conditions.push(`a.action = $${p++}`);       params.push(action);      }
    if (user_id)     { conditions.push(`a.user_id = $${p++}`);      params.push(user_id);     }
    if (from)        { conditions.push(`a.created_at >= $${p++}`);  params.push(from);        }
    if (to)          { conditions.push(`a.created_at <= $${p++}`);  params.push(to);          }

    params.push(limit, offset);

    const { rows } = await query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id,
              a.old_values, a.new_values, a.reason, a.ip_address, a.created_at,
              u.email AS user_email, u.full_name AS user_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS total FROM audit_logs a WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2)
    );

    return { data: rows, total: parseInt(countRows[0].total, 10), limit, offset };
  });

  // POST /api/audit/logs — write an audit entry
  app.post('/logs', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { action, entity_type, entity_id, old_values, new_values, reason, ip_address } = request.body;

    const { rows } = await query(
      `INSERT INTO audit_logs (company_id, user_id, action, entity_type, entity_id, old_values, new_values, reason, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, action, entity_type, entity_id, created_at`,
      [company_id, user_id, action, entity_type, entity_id ?? null,
       old_values ? JSON.stringify(old_values) : null,
       new_values ? JSON.stringify(new_values) : null,
       reason ?? null, ip_address ?? null]
    );

    return reply.status(201).send(rows[0]);
  });
}
