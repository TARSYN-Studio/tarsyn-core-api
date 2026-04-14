import { query } from '../../db.js';
function normalizeClientCode(name, index) {
  const cleaned = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .map((part) => part.slice(0, 3))
    .join('');

  const prefix = cleaned || 'CLI';
  return `${prefix}-${String(index).padStart(3, '0')}`;
}

export default async function clientRoutes(app) {
  // GET /clients — list all clients for the company
  app.get('/clients', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT c.id,
              c.name,
              COALESCE(c.client_code, '') AS client_code,
              c.contact_name AS contact_person,
              c.contact_email AS email,
              c.phone AS phone,
              c.country AS address,
              NULL AS port_of_load,
              c.port_of_destination,
              CASE WHEN c.is_active THEN 'active' ELSE 'inactive' END AS status,
              false AS is_scrap_buyer,
              c.payment_terms,
              COALESCE(c.client_type, 'spot') AS client_type,
              c.parent_client_id,
              p.name AS parent_client_name,
              c.created_at
       FROM clients c
       LEFT JOIN clients p ON p.id = c.parent_client_id
       WHERE c.company_id = $1
       ORDER BY c.name`,
      [company_id]
    );
    return reply.send(rows);
  });

  // POST /clients/import — bulk import clients from parsed CSV rows
  app.post('/clients/import', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['rows'],
        properties: {
          rows: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['name'],
              properties: {
                name: { type: 'string' },
                client_type: { type: 'string' },
                parent_company_name: { type: 'string' },
                country: { type: 'string' },
                email: { type: 'string' },
                phone: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows: inputRows } = request.body;

    const result = await query(
      `SELECT id, name FROM clients WHERE company_id = $1`,
      [company_id]
    );
    const nameMap = new Map(result.rows.map((row) => [String(row.name).trim().toLowerCase(), row]));

    let created = 0;
    let updated = 0;
    const skipped = [];

    for (let i = 0; i < inputRows.length; i += 1) {
      const raw = inputRows[i] || {};
      const name = String(raw.name || '').trim();
      if (!name) {
        skipped.push({ row: i + 1, reason: 'Missing client name' });
        continue;
      }

      const clientType = String(raw.client_type || 'spot').trim().toLowerCase() === 'contract' ? 'contract' : 'spot';
      const parentName = String(raw.parent_company_name || '').trim();
      const parent = parentName ? nameMap.get(parentName.toLowerCase()) : null;
      const country = String(raw.country || '').trim() || null;
      const email = String(raw.email || '').trim() || null;
      const phone = String(raw.phone || '').trim() || null;
      const existing = nameMap.get(name.toLowerCase());

      if (existing) {
        const { rows: updatedRows } = await query(
          `UPDATE clients
             SET client_type = $3,
                 parent_client_id = $4,
                 country = $5,
                 contact_email = $6,
                 phone = $7
           WHERE id = $1 AND company_id = $2
           RETURNING id, name`,
          [existing.id, company_id, clientType, parent?.id || null, country, email, phone]
        );
        if (updatedRows.length) {
          updated += 1;
          nameMap.set(name.toLowerCase(), updatedRows[0]);
        }
        continue;
      }

      const { rows: createdRows } = await query(
        `INSERT INTO clients (company_id, name, client_code, client_type, parent_client_id, country, contact_email, phone, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
         RETURNING id, name`,
        [company_id, name, normalizeClientCode(name, i + 1), clientType, parent?.id || null, country, email, phone]
      );
      created += 1;
      nameMap.set(name.toLowerCase(), createdRows[0]);
    }

    return reply.send({ created, updated, skipped_count: skipped.length, skipped });
  });

  // POST /clients — create a new client
  app.post('/clients', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { name, contact_person, email, phone, address, status, client_type, parent_client_id } = request.body;
    const { rows } = await query(
      `INSERT INTO clients (company_id, name, contact_name, contact_email, phone, country, is_active, client_type, parent_client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'spot'), $9)
       RETURNING id, name`,
      [company_id, name, contact_person || null, email || null, phone || null, address || null,
       status !== 'inactive', client_type || null, parent_client_id || null]
    );
    return reply.status(201).send(rows[0]);
  });

  // PATCH /clients/:id — update a client
  app.patch('/clients/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { name, contact_person, email, phone, address, status, client_type, parent_client_id } = request.body;
    const { rows } = await query(
      `UPDATE clients
       SET name             = COALESCE($3, name),
           contact_name     = COALESCE($4, contact_name),
           contact_email    = COALESCE($5, contact_email),
           phone            = COALESCE($6, phone),
           country          = COALESCE($7, country),
           is_active        = COALESCE($8, is_active),
           client_type      = COALESCE($9, client_type),
           parent_client_id = COALESCE($10, parent_client_id)
       WHERE id = $1 AND company_id = $2
       RETURNING id, name`,
      [id, company_id, name, contact_person, email, phone, address,
       status !== undefined ? status !== 'inactive' : undefined,
       client_type || null, parent_client_id || null]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Client not found' });
    return reply.send(rows[0]);
  });

  // DELETE /clients/:id — delete a client
  app.delete('/clients/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    await query(
      `DELETE FROM clients WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    return reply.send({ success: true });
  });
}
