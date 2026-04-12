export default async function clientRoutes(app) {
  // GET /production/clients — list all clients for the company
  app.get('/clients', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await app.pg.query(
      `SELECT c.id,
              c.name,
              COALESCE(c.client_code, '') AS client_code,
              c.contact_name AS contact_person,
              c.contact_email AS email,
              NULL AS phone,
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

  // POST /production/clients — create a new client
  app.post('/clients', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { name, contact_person, email, address, status, client_type, parent_client_id } = request.body;
    const { rows } = await app.pg.query(
      `INSERT INTO clients (company_id, name, contact_name, contact_email, country, is_active, client_type, parent_client_id)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'spot'), $8)
       RETURNING id, name`,
      [company_id, name, contact_person || null, email || null, address || null,
       status !== 'inactive', client_type || null, parent_client_id || null]
    );
    return reply.status(201).send(rows[0]);
  });

  // PATCH /production/clients/:id — update a client
  app.patch('/clients/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { name, contact_person, email, address, status, client_type, parent_client_id } = request.body;
    const { rows } = await app.pg.query(
      `UPDATE clients
       SET name             = COALESCE($3, name),
           contact_name     = COALESCE($4, contact_name),
           contact_email    = COALESCE($5, contact_email),
           country          = COALESCE($6, country),
           is_active        = COALESCE($7, is_active),
           client_type      = COALESCE($8, client_type),
           parent_client_id = COALESCE($9, parent_client_id)
       WHERE id = $1 AND company_id = $2
       RETURNING id, name`,
      [id, company_id, name, contact_person, email, address,
       status !== undefined ? status !== 'inactive' : undefined,
       client_type || null, parent_client_id || null]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Client not found' });
    return reply.send(rows[0]);
  });

  // DELETE /production/clients/:id — delete a client
  app.delete('/clients/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    await app.pg.query(
      `DELETE FROM clients WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    return reply.send({ success: true });
  });
}
