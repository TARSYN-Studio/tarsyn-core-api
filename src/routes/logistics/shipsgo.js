import { query } from '../../db.js';

function nextScheduleDate(baseDate, scheduleDays) {
  const base = new Date(baseDate);
  const sorted = [...scheduleDays].sort((a, b) => a - b);
  for (let offset = 0; offset <= 2; offset++) {
    const m = base.getMonth() + offset;
    const y = base.getFullYear() + Math.floor(m / 12);
    const mo = m % 12;
    for (const day of sorted) {
      const candidate = new Date(y, mo, day);
      if (candidate > base) return candidate.toISOString().split('T')[0];
    }
  }
  return null;
}

function calcPaymentDueDate(contract, blDate, arrivalDate) {
  if (!contract) {
    if (!arrivalDate) return null;
    const d = new Date(arrivalDate);
    d.setDate(d.getDate() + 5);
    return d.toISOString().split('T')[0];
  }
  if (contract.payment_terms === '60_days') {
    const bl60 = blDate ? new Date(new Date(blDate).setDate(new Date(blDate).getDate() + 60)) : null;
    const arr  = arrivalDate ? new Date(arrivalDate) : null;
    const base = bl60 && arr ? (bl60 > arr ? bl60 : arr) : (bl60 || arr);
    return base ? base.toISOString().split('T')[0] : null;
  }
  if (contract.payment_terms === 'custom' && contract.payment_schedule_dates?.length) {
    const bl60 = blDate ? new Date(new Date(blDate).setDate(new Date(blDate).getDate() + 60)) : null;
    const arr  = arrivalDate ? new Date(arrivalDate) : null;
    const base = bl60 && arr ? (bl60 > arr ? bl60 : arr) : (bl60 || arr || new Date());
    return nextScheduleDate(base, contract.payment_schedule_dates);
  }
  if (!arrivalDate) return null;
  const d = new Date(arrivalDate);
  d.setDate(d.getDate() + 5);
  return d.toISOString().split('T')[0];
}

export default async function shipsgoRoutes(app) {

  app.post('/shipsgo-register', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { sales_order_id, bl_number } = request.body ?? {};

    if (!sales_order_id || !bl_number) {
      return reply.status(400).send({ error: 'sales_order_id and bl_number required' });
    }

    const { rows: soRows } = await query(
      `SELECT id FROM sales_orders WHERE id = $1 AND company_id = $2`,
      [sales_order_id, company_id]
    );
    if (soRows.length === 0) return reply.status(404).send({ error: 'Sales order not found' });

    const apiKey = process.env.SHIPSGO_API_KEY;
    let trackingId = bl_number;

    try {
      const res = await fetch('https://api.shipsgo.com/api/v2/ShipmentService/AddShipment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          blNumber: bl_number,
          notificationUrl: 'https://netaj.co/api/logistics/shipsgo-webhook',
        }),
      });
      if (res.ok) {
        const data = await res.json();
        trackingId = data?.shipmentId ?? data?.id ?? bl_number;
      }
    } catch { /* network error — still store BL */ }

    const { rows } = await query(
      `UPDATE sales_orders
       SET bl_number = $3, shipsgo_tracking_id = $4, updated_at = now()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [sales_order_id, company_id, bl_number, trackingId]
    );

    return { success: true, sales_order: rows[0], tracking_id: trackingId };
  });

  app.post('/shipsgo-webhook', async (request, reply) => {
    const payload = request.body ?? {};
    const blNumber    = payload.blNumber ?? payload.bl_number ?? payload.BLNumber;
    const arrivalDate = payload.arrivalDate ?? payload.arrival_date ?? payload.ArrivalDate;
    const trackingId  = payload.shipmentId ?? payload.id;

    if (!blNumber && !trackingId) {
      return reply.status(400).send({ error: 'No BL number or tracking ID in payload' });
    }

    const { rows: soRows } = await query(
      `SELECT so.*, c.payment_terms, c.payment_schedule_dates
       FROM sales_orders so
       LEFT JOIN contracts c ON c.id = so.contract_id
       WHERE so.bl_number = $1 OR so.shipsgo_tracking_id = $2
       LIMIT 1`,
      [blNumber ?? '', trackingId ?? '']
    );

    if (soRows.length === 0) return reply.send({ received: true, matched: false });

    const so = soRows[0];
    const contractInfo = so.payment_terms ? {
      payment_terms: so.payment_terms,
      payment_schedule_dates: so.payment_schedule_dates,
    } : null;

    const due = calcPaymentDueDate(contractInfo, so.bl_date, arrivalDate);

    await query(
      `UPDATE sales_orders
       SET actual_arrival   = COALESCE($2, actual_arrival),
           payment_due_date = COALESCE($3, payment_due_date),
           payment_status   = CASE WHEN payment_status = 'pending' THEN 'due' ELSE payment_status END,
           status           = CASE WHEN status IN ('booked','shipped') THEN 'delivered' ELSE status END,
           updated_at       = now()
       WHERE id = $1`,
      [so.id, arrivalDate ?? null, due]
    );

    app.log.info({ event: 'shipsgo_arrival', sales_order_id: so.id, bl_number: blNumber });
    return reply.send({ received: true, matched: true, sales_order_id: so.id });
  });

  app.get('/shipments-dashboard', { preHandler: [app.authenticate] }, async (request, _reply) => {
    const { company_id } = request.user;
    const today     = new Date().toISOString().split('T')[0];
    const sevenDays = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

    const [{ rows: inTransit }, { rows: dueThisWeek }, { rows: overdue }] = await Promise.all([
      query(
        `SELECT so.id, so.order_number, so.bl_number, so.vessel_name,
                so.eta, so.port_of_discharge, so.status,
                so.quantity_mt, so.total_value, so.currency,
                cl.name AS client_name
         FROM sales_orders so
         LEFT JOIN clients cl ON cl.id = so.client_id
         WHERE so.company_id = $1 AND so.status IN ('booked','shipped') AND so.bl_number IS NOT NULL
         ORDER BY so.eta ASC NULLS LAST`,
        [company_id]
      ),
      query(
        `SELECT so.id, so.order_number, so.payment_due_date,
                so.total_value, so.currency, so.payment_status,
                cl.name AS client_name
         FROM sales_orders so
         LEFT JOIN clients cl ON cl.id = so.client_id
         WHERE so.company_id = $1
           AND so.payment_due_date BETWEEN $2 AND $3
           AND so.payment_status IN ('pending','due')
         ORDER BY so.payment_due_date ASC`,
        [company_id, today, sevenDays]
      ),
      query(
        `SELECT so.id, so.order_number, so.payment_due_date,
                so.total_value, so.currency, so.payment_status,
                cl.name AS client_name
         FROM sales_orders so
         LEFT JOIN clients cl ON cl.id = so.client_id
         WHERE so.company_id = $1
           AND so.payment_due_date < $2
           AND so.payment_status IN ('pending','due')
         ORDER BY so.payment_due_date ASC`,
        [company_id, today]
      ),
    ]);

    if (overdue.length > 0) {
      await query(
        `UPDATE sales_orders SET payment_status = 'overdue', updated_at = now()
         WHERE id = ANY($1::uuid[]) AND payment_status != 'paid'`,
        [overdue.map(r => r.id)]
      );
    }

    return { in_transit: inTransit, due_this_week: dueThisWeek, overdue };
  });
}
