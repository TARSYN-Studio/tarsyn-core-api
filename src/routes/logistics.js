import { query } from '../db.js';

export default async function logisticsRoutes(app) {

  // ── GET /api/logistics/emails ────────────────────────────────
  // email_queue table not yet in Hetzner DB — returns empty until migrated
  app.get('/emails', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    return { data: [], total: 0 };
  });

  // ── PATCH /api/logistics/emails/:id ──────────────────────────
  app.patch('/emails/:id', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    return reply.status(200).send({ id: request.params.id, ...request.body });
  });

  // ── POST /api/logistics/emails/:id/send ──────────────────────
  app.post('/emails/:id/send', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    return reply.status(200).send({ success: true, message: 'Email sending not yet configured on this server' });
  });

  // ── POST /api/logistics/notify ───────────────────────────────
  app.post('/notify', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    console.log('[logistics notify]', request.body);
    return reply.status(200).send({ success: true });
  });

  // ── POST /api/documents/upload-to-onedrive ───────────────────
  // Stub until OneDrive is connected to Hetzner server
  app.post('/upload-to-onedrive', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { fileName, bookingReference, documentType } = request.body ?? {};
    const stubUrl = `/uploads/${documentType}/${bookingReference}_${Date.now()}_${fileName || 'doc'}`;
    console.log('[upload-to-onedrive stub]', { fileName, bookingReference, documentType });
    return reply.status(200).send({ webUrl: stubUrl, success: true, stub: true });
  });

  // ── GET /api/logistics/orders ────────────────────────────────
  // Fetch logistics-relevant orders with extended fields
  app.get('/orders', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          statuses:          { type: 'string' },
          transport_status:  { type: 'string' },
          limit:             { type: 'integer', minimum: 1, maximum: 500, default: 200 },
          offset:            { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { statuses, transport_status, limit, offset } = request.query;

    const conditions = ['company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (statuses) {
      const list = statuses.split(',').map(s => s.trim()).filter(Boolean);
      if (list.length > 0) {
        conditions.push(`status = ANY($${p++})`);
        params.push(list);
      }
    }
    if (transport_status) {
      conditions.push(`transport_status = $${p++}`);
      params.push(transport_status);
    }

    params.push(limit, offset);

    const { rows } = await query(
      `SELECT * FROM production_orders
       WHERE ${conditions.join(' AND ')}
       ORDER BY etd ASC NULLS LAST, created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    return { data: rows, total: rows.length };
  });

  // ── POST /api/logistics/process-bl-document ──────────────────
  app.post('/process-bl-document', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    // AI BL extraction not yet configured on Hetzner server
    return reply.status(200).send({
      success: false,
      error: 'AI BL processing not yet configured on this server',
      data: null
    });
  });

  // ── POST /api/logistics/send-email ───────────────────────────
  app.post('/send-email', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    console.log('[send-email stub]', request.body?.type, request.body?.subject);
    return reply.status(200).send({ success: true, stub: true });
  });
}
