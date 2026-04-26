import { query } from '../db.js';
import { queueEmail, emailTemplate } from '../services/email.js';

const ALLOWED_BOOKING_STATUSES = ['pending','confirmed','in_transit','documented','completed'];

// ── ShipsGo v2.0 helpers ─────────────────────────────────────────────────────
const SHIPSGO_BASE = 'https://api.shipsgo.com/v2';

function shipsGoAuthHeaders() {
  const token = process.env.SHIPSGO_API_KEY;
  if (!token) throw new Error('SHIPSGO_API_KEY not configured');
  return { 'Content-Type': 'application/json', 'X-Shipsgo-User-Token': token };
}

// Parse v2.0 shipment response into flat tracking fields for our DB
function parseShipsGoV2(shipment) {
  if (!shipment) return {};
  const movements = shipment.containers?.[0]?.movements ?? [];
  // Last actual (ACT) movement for location
  const lastAct = [...movements].reverse().find(m => m.status === 'ACT');
  const lastEvent    = shipment.status ?? lastAct?.event ?? null;
  const lastLocation = lastAct?.location?.name ?? shipment.route?.port_of_loading?.location?.name ?? null;
  const eta          = shipment.route?.port_of_discharge?.date_of_discharge ?? null;
  return { trackingId: String(shipment.id ?? ''), lastEvent, lastLocation, eta };
}

// Register a new shipment — returns { id, reference, container_number }
// 409 = already exists in ShipsGo — treated as success (returns existing shipment)
async function registerShipsGoShipment(containerNumber, { reference, tags, followers } = {}) {
  const body = { container_number: containerNumber };
  if (reference) body.reference = String(reference).slice(0, 128);
  if (tags?.length) body.tags = tags.slice(0, 10).map(t => String(t).slice(0, 64));
  if (followers?.length) body.followers = followers.slice(0, 10);
  const response = await fetch(`${SHIPSGO_BASE}/ocean/shipments`, {
    method: 'POST',
    headers: shipsGoAuthHeaders(),
    body: JSON.stringify(body),
  });
  // 409 = ALREADY_EXISTS — ShipsGo returns existing shipment, treat as success
  if (!response.ok && response.status !== 409) {
    const err = await response.text().catch(() => response.statusText);
    throw new Error(`ShipsGo register: ${response.status} ${err}`);
  }
  const data = await response.json();
  return data.shipment ?? data;
}

// Get latest tracking data for an already-registered shipment
async function getShipsGoTracking(shipmentId) {
  const { 'Content-Type': _ct, ...headers } = shipsGoAuthHeaders();
  const response = await fetch(`${SHIPSGO_BASE}/ocean/shipments/${shipmentId}`, {
    method: 'GET', headers,
  });
  if (!response.ok) {
    const err = await response.text().catch(() => response.statusText);
    throw new Error(`ShipsGo tracking: ${response.status} ${err}`);
  }
  return response.json();
}

// Update Odoo invoice number reference on an already-registered shipment
async function updateShipsGoReference(shipmentId, reference) {
  const response = await fetch(`${SHIPSGO_BASE}/ocean/shipments/${shipmentId}`, {
    method: 'PATCH',
    headers: shipsGoAuthHeaders(),
    body: JSON.stringify({ reference: String(reference).slice(0, 128) }),
  });
  if (!response.ok) {
    const err = await response.text().catch(() => response.statusText);
    throw new Error(`ShipsGo update: ${response.status} ${err}`);
  }
  return response.json();
}

// ── Teams notification helper ─────────────────────────────────────────────────
async function notifyTeams(text, color = '#0078D4') {
  const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('[logistics/teams] TEAMS_WEBHOOK_URL not set. Message:', text.replace(/<[^>]+>/g, ''));
    return;
  }
  try {
    const payload = {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.3',
          body: [{
            type: 'TextBlock',
            text: text.replace(/<br>/g, '\n').replace(/<[^>]+>/g, ''),
            wrap: true,
            color: color === '#991b1b' ? 'Attention' : 'Default',
          }],
          msteams: { width: 'Full' },
        },
      }],
    };
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[logistics/teams] Send failed:', res.status, err.slice(0, 200));
    }
  } catch (e) {
    console.error('[logistics/teams] Notify error:', e.message);
  }
}

export default async function logisticsRoutes(app) {

  // ── GET /api/logistics/emails ─────────────────────────────────
  app.get('/emails', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT * FROM logistics_emails WHERE company_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [company_id]
    );
    return { data: rows, total: rows.length };
  });

  // ── POST /api/logistics/emails ────────────────────────────────
  app.post('/emails', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id } = request.user;
    const {
      to_email, to_name, subject, body_html,
      transaction_id, transaction_type, priority = 0,
    } = request.body ?? {};

    if (!to_email || !subject) {
      return reply.status(400).send({ error: 'to_email and subject are required' });
    }

    const { rows } = await query(
      `INSERT INTO logistics_emails
         (company_id, transaction_id, transaction_type, to_email, to_name, subject, body_html, priority, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft')
       RETURNING *`,
      [company_id, transaction_id ?? null, transaction_type ?? null,
       to_email, to_name ?? null, subject, body_html ?? null, priority]
    );
    return reply.status(201).send(rows[0]);
  });

  // ── PATCH /api/logistics/emails/:id ──────────────────────────
  app.patch('/emails/:id', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { to_email, to_name, subject, body_html, priority, status } = request.body ?? {};

    const sets = [];
    const params = [id, company_id];
    let p = 3;

    if (to_email !== undefined) { sets.push(`to_email = $${p++}`); params.push(to_email); }
    if (to_name !== undefined)  { sets.push(`to_name = $${p++}`);  params.push(to_name); }
    if (subject !== undefined)  { sets.push(`subject = $${p++}`);  params.push(subject); }
    if (body_html !== undefined){ sets.push(`body_html = $${p++}`);params.push(body_html); }
    if (priority !== undefined) { sets.push(`priority = $${p++}`); params.push(priority); }
    if (status !== undefined)   { sets.push(`status = $${p++}`);   params.push(status); }

    if (sets.length === 0) {
      return reply.status(400).send({ error: 'Nothing to update' });
    }

    const { rows } = await query(
      `UPDATE logistics_emails SET ${sets.join(', ')} WHERE id=$1 AND company_id=$2 RETURNING *`,
      params
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Email not found' });
    return rows[0];
  });

  // ── POST /api/logistics/emails/:id/send ──────────────────────
  app.post('/emails/:id/send', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;

    const { rows } = await query(
      `SELECT * FROM logistics_emails WHERE id=$1 AND company_id=$2`,
      [id, company_id]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Email not found' });

    const email = rows[0];
    if (email.status === 'sent') {
      return reply.status(400).send({ error: 'Email already sent' });
    }

    try {
      await queueEmail({
        company_id,
        to: { email: email.to_email, name: email.to_name },
        subject: email.subject,
        body_html: email.body_html ?? '',
        transaction_id: email.transaction_id,
        transaction_type: email.transaction_type ?? 'logistics',
        priority: email.priority > 0 ? 'high' : 'normal',
      });

      const { rows: updated } = await query(
        `UPDATE logistics_emails SET status='sent', sent_at=now() WHERE id=$1 RETURNING *`,
        [id]
      );
      return { success: true, email: updated[0] };
    } catch (err) {
      await query(
        `UPDATE logistics_emails SET status='failed', error_message=$1 WHERE id=$2`,
        [err.message, id]
      );
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // ── POST /api/logistics/notify ───────────────────────────────
  app.post('/notify', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { eventType, details } = request.body ?? {};
    console.log('[logistics/notify]', eventType, details);

    const text = eventType
      ? `📦 Logistics Event: ${eventType}\n${typeof details === 'object' ? JSON.stringify(details, null, 2) : (details ?? '')}`
      : `📦 Logistics notification\n${JSON.stringify(request.body ?? {})}`;

    await notifyTeams(text);
    return reply.status(200).send({ success: true });
  });

  // SharePoint-backed upload for logistics documents.
  // Endpoint name kept as /upload-to-onedrive for frontend
  // back-compat — destination is now SharePoint, folder path:
  //   Logistics/{bookingReference}/{documentType}_{filename}
  app.post('/upload-to-onedrive', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { fileData, fileName, bookingReference, documentType } = request.body ?? {};
    if (!fileData || !fileName) {
      return reply.status(400).send({ error: 'fileData and fileName are required' });
    }
    try {
      const { uploadToSharePoint, sendSharePointError } = await import('../services/sharepoint.js');
      const safe = s => (s || '').replace(/[^a-zA-Z0-9._-]/g, '_');
      const docTag = safe(documentType) || 'doc';
      const safeName = safe(fileName.replace(/^.*[\\/]/, ''));
      const folder = `Logistics/${safe(bookingReference) || 'unassigned'}`;
      const finalName = `${docTag}_${safeName}`;
      const base64Data = fileData.replace(/^data:[^;]+;base64,/, '');
      try {
        const result = await uploadToSharePoint({
          folderPath: folder,
          fileName: finalName,
          buffer: Buffer.from(base64Data, 'base64'),
        });
        return reply.status(200).send({ webUrl: result.webUrl, sharepoint_id: result.itemId, success: true });
      } catch (err) {
        return sendSharePointError(reply, err);
      }
    } catch (err) {
      console.error('[upload-document]', err);
      return reply.status(500).send({ error: 'Upload failed' });
    }
  });

  // ── GET /api/logistics/orders ────────────────────────────────
  app.get('/orders', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          statuses:           { type: 'string' },
          transport_statuses: { type: 'string' },
          transport_status:   { type: 'string' },
          limit:              { type: 'integer', minimum: 1, maximum: 500, default: 200 },
          offset:             { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { statuses, transport_statuses, transport_status, limit, offset } = request.query;

    const orGroups = [];
    const params = [company_id];
    let p = 2;

    if (statuses) {
      const list = statuses.split(',').map(s => s.trim()).filter(Boolean);
      if (list.length > 0) {
        orGroups.push(`po.status = ANY($${p++})`);
        params.push(list);
      }
    }
    if (transport_statuses) {
      const list = transport_statuses.split(',').map(s => s.trim()).filter(Boolean);
      if (list.length > 0) {
        orGroups.push(`po.transport_status = ANY($${p++})`);
        params.push(list);
      }
    }
    if (transport_status) {
      orGroups.push(`po.transport_status = $${p++}`);
      params.push(transport_status);
    }

    const filterClause = orGroups.length > 0
      ? `AND (${orGroups.join(' OR ')})`
      : '';

    params.push(limit, offset);

    const { rows } = await query(
      `SELECT po.*,
              c.name AS client_name,
              c.payment_terms_days AS client_payment_terms_days,
              c.payment_schedule_type AS client_payment_schedule_type,
              c.payment_schedule_dates AS client_payment_schedule_dates,
              c.require_shipment_arrival AS client_require_shipment_arrival,
              c.arrival_lead_days AS client_arrival_lead_days
       FROM production_orders po
       LEFT JOIN clients c ON c.id = po.client_id
       WHERE po.company_id = $1 ${filterClause}
       ORDER BY po.etd ASC NULLS LAST, po.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    return { data: rows, total: rows.length };
  });

  // ── GET /api/logistics/shipments ─────────────────────────────
  app.get('/shipments', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT po.*, c.name as client_name, c.contact_email as client_email
       FROM production_orders po
       LEFT JOIN clients c ON c.id = po.client_id
       WHERE po.company_id = $1
         AND (po.transport_status IN ('booked','in_transit','at_port','delivered')
              OR po.booking_status IN ('confirmed','in_transit','documented'))
       ORDER BY po.etd ASC NULLS LAST`,
      [company_id]
    );
    return { data: rows, total: rows.length };
  });

  // ── GET /api/logistics/booking-logs ──────────────────────────
  app.get('/booking-logs', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT * FROM booking_logs WHERE company_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [company_id]
    );
    return { data: rows, total: rows.length };
  });

  // ── POST /api/logistics/track-container ──────────────────────
  app.post('/track-container', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { order_id, container_number } = request.body ?? {};

    if (!container_number) {
      return reply.status(400).send({ error: 'container_number is required' });
    }

    let trackingData = null;
    let trackingError = null;

    try {
      // Use existing shipsgo_tracking_id if present, else register fresh
      if (order_id) {
        const { rows: existingOrder } = await query(
          'SELECT shipsgo_tracking_id FROM production_orders WHERE id=$1 AND company_id=$2',
          [order_id, company_id]
        );
        const existingId = existingOrder[0]?.shipsgo_tracking_id;
        if (existingId) {
          trackingData = await getShipsGoTracking(existingId);
        } else {
          trackingData = await registerShipsGoShipment(container_number);
        }
      } else {
        trackingData = await registerShipsGoShipment(container_number);
      }
    } catch (err) {
      trackingError = err.message;
      console.error('[ShipsGo] Tracking error:', err.message);
    }

    // Extract fields from ShipsGo response (flexible — may vary by container status)
    const parsedTrack  = parseShipsGoV2(trackingData?.shipment ?? trackingData);
    const trackingId   = parsedTrack.trackingId || trackingData?.id?.toString() || null;
    const lastEvent    = parsedTrack.lastEvent    || null;
    const lastLocation = parsedTrack.lastLocation || null;
    const shipsgoEta   = parsedTrack.eta          || null;

    // Update order if order_id provided
    if (order_id) {
      await query(
        `UPDATE production_orders
         SET shipsgo_container_number = $1,
             shipsgo_tracking_id      = $2,
             shipsgo_last_event       = $3,
             shipsgo_last_location    = $4,
             shipsgo_last_updated     = now(),
             shipsgo_eta              = $5
         WHERE id = $6 AND company_id = $7`,
        [container_number, trackingId, lastEvent, lastLocation, shipsgoEta, order_id, company_id]
      );

      // Log action
      await query(
        `INSERT INTO booking_logs (company_id, order_id, action, notes, metadata)
         VALUES ($1,$2,'track_container',$3,$4)`,
        [company_id, order_id, `Tracked container ${container_number}`, JSON.stringify({ trackingId, error: trackingError })]
      );
    }

    return {
      success: !trackingError,
      container_number,
      tracking_data: trackingData,
      tracking_id: trackingId,
      last_event: lastEvent,
      last_location: lastLocation,
      eta: shipsgoEta,
      error: trackingError ?? undefined,
    };
  });

  // ── GET /api/logistics/tracking/:orderId ─────────────────────
  app.get('/tracking/:orderId', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { orderId } = request.params;

    const { rows } = await query(
      `SELECT * FROM production_orders WHERE id = $1 AND company_id = $2`,
      [orderId, company_id]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Order not found' });

    const order = rows[0];

    // Re-fetch from ShipsGo if tracking exists and last update > 1 hour ago (or never updated)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const needsRefresh = order.shipsgo_tracking_id &&
      (!order.shipsgo_last_updated || new Date(order.shipsgo_last_updated) < oneHourAgo);

    if (needsRefresh && order.shipsgo_container_number) {
      try {
        const trackingRaw  = await getShipsGoTracking(order.shipsgo_tracking_id);
        const trackingData = trackingRaw?.shipment ?? trackingRaw;
        const parsed2      = parseShipsGoV2(trackingData);
        const lastEvent    = parsed2.lastEvent    || order.shipsgo_last_event;
        const lastLocation = parsed2.lastLocation || order.shipsgo_last_location;
        const shipsgoEta   = parsed2.eta          || null;

        await query(
          `UPDATE production_orders
           SET shipsgo_last_event    = $1,
               shipsgo_last_location = $2,
               shipsgo_last_updated  = now(),
               shipsgo_eta           = $3
           WHERE id = $4`,
          [lastEvent, lastLocation, shipsgoEta, orderId]
        );

        order.shipsgo_last_event    = lastEvent;
        order.shipsgo_last_location = lastLocation;
        order.shipsgo_last_updated  = new Date().toISOString();
        order.shipsgo_eta           = shipsgoEta;
      } catch (err) {
        console.error('[ShipsGo] Re-fetch error for order', orderId, err.message);
      }
    }

    return {
      order_id: orderId,
      tracking_id: order.shipsgo_tracking_id,
      container_number: order.shipsgo_container_number,
      last_event: order.shipsgo_last_event,
      last_location: order.shipsgo_last_location,
      last_updated: order.shipsgo_last_updated,
      eta: order.shipsgo_eta,
      booking_status: order.booking_status,
    };
  });

  // ── PATCH /api/logistics/orders/:id/booking-status ───────────
  app.patch('/orders/:id/booking-status', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { booking_status, vessel_name, bl_number, etd, container_number } = request.body ?? {};

    if (!booking_status) {
      return reply.status(400).send({ error: 'booking_status is required' });
    }
    if (!ALLOWED_BOOKING_STATUSES.includes(booking_status)) {
      return reply.status(400).send({
        error: `Invalid booking_status. Allowed: ${ALLOWED_BOOKING_STATUSES.join(', ')}`,
      });
    }

    // Fetch current order
    const { rows: existing } = await query(
      `SELECT * FROM production_orders WHERE id=$1 AND company_id=$2`,
      [id, company_id]
    );
    if (existing.length === 0) return reply.status(404).send({ error: 'Order not found' });

    const old = existing[0];

    const sets = ['booking_status = $1'];
    const params = [booking_status, id, company_id];
    let p = 4;

    if (vessel_name !== undefined)     { sets.push(`vessel_name = $${p++}`);      params.push(vessel_name); }
    if (bl_number !== undefined)       { sets.push(`bl_number = $${p++}`);        params.push(bl_number); }
    if (etd !== undefined)             { sets.push(`etd = $${p++}`);              params.push(etd); }
    if (container_number !== undefined){ sets.push(`shipsgo_container_number = $${p++}`); params.push(container_number); }

    const { rows } = await query(
      `UPDATE production_orders SET ${sets.join(', ')} WHERE id=$2 AND company_id=$3 RETURNING *`,
      params
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Order not found' });

    const updated = rows[0];

    // Log the status change
    await query(
      `INSERT INTO booking_logs (company_id, order_id, action, old_status, new_status, changed_by, notes)
       VALUES ($1,$2,'booking_status_change',$3,$4,$5,$6)`,
      [company_id, id, old.booking_status, booking_status,
       request.user.email ?? 'system',
       `Status changed from ${old.booking_status ?? 'none'} to ${booking_status}`]
    );

    // Auto-register with ShipsGo v2.0 when booking confirmed + container number present
    if (booking_status === 'confirmed' && (container_number || updated.shipsgo_container_number)) {
      const cnum = container_number || updated.shipsgo_container_number;
      // Fetch client name for tagging
      let clientTag = null;
      try {
        const { rows: cr } = await query('SELECT name FROM clients WHERE id=$1', [updated.client_id]);
        if (cr[0]?.name) clientTag = cr[0].name;
      } catch {}
      try {
        const shipment = await registerShipsGoShipment(cnum, {
          reference: updated.invoice_number || undefined,
          tags: clientTag ? [clientTag] : undefined,
          followers: [process.env.SHIPSGO_NOTIFY_EMAIL || 'logistics@netaj.sa'],
        });
        const parsed    = parseShipsGoV2(shipment);
        const trackingId   = parsed.trackingId || null;
        const lastEvent    = parsed.lastEvent   || null;
        const lastLocation = parsed.lastLocation || null;
        const shipsgoEta   = parsed.eta          || null;

        await query(
          `UPDATE production_orders
           SET shipsgo_tracking_id      = $1,
               shipsgo_last_event       = $2,
               shipsgo_last_location    = $3,
               shipsgo_last_updated     = now(),
               shipsgo_eta              = $4
           WHERE id = $5`,
          [trackingId, lastEvent, lastLocation, shipsgoEta, id]
        );

        updated.shipsgo_tracking_id   = trackingId;
        updated.shipsgo_last_event    = lastEvent;
        updated.shipsgo_last_location = lastLocation;
        updated.shipsgo_eta           = shipsgoEta;

        await notifyTeams(
          `📦 Booking Confirmed + Tracking Started\nOrder: ${updated.order_number ?? id}\nContainer: ${cnum}\nStatus: ${booking_status}`,
          '#166534'
        );
      } catch (err) {
        console.error('[ShipsGo] Auto-track error:', err.message);
      }
    }

    return { success: true, order: updated };
  });

  // ── POST /api/logistics/process-bl-document ──────────────────
  app.post('/process-bl-document', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    return reply.status(200).send({
      success: false,
      error: 'AI BL processing not yet configured on this server',
      data: null,
    });
  });

  // ── POST /api/logistics/send-email ───────────────────────────
  app.post('/send-email', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    console.log('[send-email stub]', request.body?.type, request.body?.subject);
    return reply.status(200).send({ success: true, stub: true });
  });

  // ── POST /api/logistics/send-to-3pl ──────────────────────────
  app.post('/send-to-3pl', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { supplier_id, order_id, email_template, custom_message } = request.body ?? {};

    if (!supplier_id || !email_template) {
      return reply.status(400).send({ error: 'supplier_id and email_template are required' });
    }

    // Fetch supplier email
    const { rows: suppliers } = await query(
      `SELECT * FROM suppliers WHERE id=$1 AND company_id=$2`,
      [supplier_id, company_id]
    );
    if (suppliers.length === 0) return reply.status(404).send({ error: 'Supplier not found' });

    const supplier = suppliers[0];
    const toEmail = supplier.email ?? supplier.contact_email;
    if (!toEmail) {
      return reply.status(400).send({ error: 'Supplier has no email address on file' });
    }

    // Fetch order details if provided
    let order = null;
    if (order_id) {
      const { rows: orders } = await query(
        `SELECT * FROM production_orders WHERE id=$1 AND company_id=$2`,
        [order_id, company_id]
      );
      order = orders[0] ?? null;
    }

    // Generate email content based on template
    let subject = '';
    let body_html = '';

    const orderRef = order?.order_number ?? order_id ?? 'N/A';

    if (email_template === 'booking_request') {
      subject = `Booking Request — Order ${orderRef}`;
      body_html = emailTemplate('Booking Request', `
        <p>Dear ${supplier.name},</p>
        <p>We would like to request a booking for the following shipment:</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:6px 0;color:#6b7280">Order Reference:</td><td><strong>${orderRef}</strong></td></tr>
          ${order?.etd ? `<tr><td style="padding:6px 0;color:#6b7280">ETD:</td><td>${new Date(order.etd).toLocaleDateString('en-GB')}</td></tr>` : ''}
          ${order?.port_of_loading ? `<tr><td style="padding:6px 0;color:#6b7280">Port of Loading:</td><td>${order.port_of_loading}</td></tr>` : ''}
          ${order?.port_of_destination ? `<tr><td style="padding:6px 0;color:#6b7280">Port of Destination:</td><td>${order.port_of_destination}</td></tr>` : ''}
        </table>
        ${custom_message ? `<p>${custom_message}</p>` : ''}
        <p>Please confirm availability and send us your quotation.</p>
        <p>Best regards,<br>Netaj Logistics Team</p>
      `);
    } else if (email_template === 'pickup_notification') {
      subject = `Pickup Notification — Order ${orderRef}`;
      body_html = emailTemplate('Pickup Notification', `
        <p>Dear ${supplier.name},</p>
        <p>This is to notify you that goods for order <strong>${orderRef}</strong> are ready for pickup.</p>
        ${custom_message ? `<p>${custom_message}</p>` : ''}
        <p>Please coordinate pickup at your earliest convenience.</p>
        <p>Best regards,<br>Netaj Logistics Team</p>
      `);
    } else if (email_template === 'document_request') {
      subject = `Document Request — Order ${orderRef}`;
      body_html = emailTemplate('Document Request', `
        <p>Dear ${supplier.name},</p>
        <p>We kindly request the following documents for order <strong>${orderRef}</strong>:</p>
        <ul>
          <li>Bill of Lading</li>
          <li>Packing List</li>
          <li>Certificate of Origin</li>
        </ul>
        ${custom_message ? `<p>${custom_message}</p>` : ''}
        <p>Please send them at your earliest convenience.</p>
        <p>Best regards,<br>Netaj Logistics Team</p>
      `);
    } else {
      subject = `Logistics Notification — Order ${orderRef}`;
      body_html = emailTemplate('Logistics Notification', `
        <p>Dear ${supplier.name},</p>
        ${custom_message ? `<p>${custom_message}</p>` : '<p>Please see the details for the order referenced above.</p>'}
        <p>Best regards,<br>Netaj Logistics Team</p>
      `);
    }

    // Insert into logistics_emails
    const { rows: emailRows } = await query(
      `INSERT INTO logistics_emails
         (company_id, transaction_id, transaction_type, to_email, to_name, subject, body_html, priority, status)
       VALUES ($1,$2,'logistics_3pl',$3,$4,$5,$6,1,'draft')
       RETURNING *`,
      [company_id, order_id ?? null, toEmail, supplier.name ?? null, subject, body_html]
    );
    const emailRecord = emailRows[0];

    // Auto-send via queueEmail
    try {
      await queueEmail({
        company_id,
        to: { email: toEmail, name: supplier.name },
        subject,
        body_html,
        transaction_id: order_id ?? null,
        transaction_type: '3pl_communication',
        priority: 'high',
      });

      await query(
        `UPDATE logistics_emails SET status='sent', sent_at=now() WHERE id=$1`,
        [emailRecord.id]
      );
      emailRecord.status = 'sent';
    } catch (err) {
      await query(
        `UPDATE logistics_emails SET status='failed', error_message=$1 WHERE id=$2`,
        [err.message, emailRecord.id]
      );
      emailRecord.status  = 'failed';
      emailRecord.error_message = err.message;
    }

    return { success: emailRecord.status === 'sent', email_id: emailRecord.id, email: emailRecord };
  });
  // ── PATCH /api/logistics/orders/:id/invoice-reference ────────────────────
  // Called by Finance when entering the Odoo invoice number (NTJ/INV/YY/NNNNN).
  // Updates production_orders.invoice_number and pushes reference to ShipsGo.
  app.patch('/orders/:id/invoice-reference', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { invoice_number } = request.body ?? {};

    if (!invoice_number) return reply.status(400).send({ error: 'invoice_number required' });

    // Update DB
    const { rows } = await query(
      `UPDATE production_orders
       SET invoice_number = $1, updated_at = now()
       WHERE id = $2 AND company_id = $3
       RETURNING id, shipsgo_tracking_id`,
      [invoice_number, id, company_id]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'Order not found' });

    const order = rows[0];
    let shipsgoUpdated = false;
    let shipsgoError = null;

    // Push reference to ShipsGo if shipment is already registered
    if (order.shipsgo_tracking_id) {
      try {
        await updateShipsGoReference(order.shipsgo_tracking_id, invoice_number);
        shipsgoUpdated = true;
      } catch (err) {
        shipsgoError = err.message;
        console.error('[ShipsGo] Reference update failed:', err.message);
      }
    }

    return reply.status(200).send({ success: true, shipsgoUpdated, shipsgoError });
  });

}