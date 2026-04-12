import { query } from '../../db.js';

export default async function emailQueueRoutes(app) {

  // GET /api/email-queue
  app.get('/', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status:           { type: 'string' },
          transaction_type: { type: 'string' },
          limit:            { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset:           { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { status, transaction_type, limit, offset } = request.query;

    const conditions = ['company_id = $1'];
    const params = [company_id];
    let p = 2;
    if (status)           { conditions.push(`status = $${p++}`);           params.push(status);           }
    if (transaction_type) { conditions.push(`transaction_type = $${p++}`); params.push(transaction_type); }
    params.push(limit, offset);

    const { rows } = await query(
      `SELECT id, transaction_id, transaction_type, recipients, subject,
              status, priority, sent_at, error_message, created_at, updated_at
       FROM email_queue
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    return { data: rows, limit, offset };
  });

  // GET /api/email-queue/:id
  app.get('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { rows } = await query(
      `SELECT * FROM email_queue WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (!rows.length) return reply.status(404).send({ error: 'Email not found' });
    return rows[0];
  });

  // POST /api/email-queue
  app.post('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { transaction_id, transaction_type, recipients, subject, body_html, priority, metadata } = request.body;

    const { rows } = await query(
      `INSERT INTO email_queue (company_id, transaction_id, transaction_type, recipients, subject, body_html, priority, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, status, created_at`,
      [company_id, transaction_id ?? null, transaction_type ?? null,
       JSON.stringify(recipients ?? []), subject ?? null, body_html ?? null,
       priority ?? 'normal', metadata ? JSON.stringify(metadata) : null]
    );
    return reply.status(201).send(rows[0]);
  });

  // PATCH /api/email-queue/:id
  app.patch('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { status, error_message } = request.body;

    const sets = ['updated_at = now()'];
    const params = [id, company_id];
    let p = 3;
    if (status !== undefined)        { sets.push(`status = $${p++}`);        params.push(status);        }
    if (status === 'sent')           { sets.push('sent_at = now()'); }
    if (error_message !== undefined) { sets.push(`error_message = $${p++}`); params.push(error_message); }

    const { rows } = await query(
      `UPDATE email_queue SET ${sets.join(', ')} WHERE id = $1 AND company_id = $2 RETURNING id, status, updated_at`,
      params
    );
    if (!rows.length) return reply.status(404).send({ error: 'Email not found' });
    return rows[0];
  });
}
