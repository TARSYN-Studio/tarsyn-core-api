import { query } from '../db.js';
import { reverseDocument, cancelDocument, sendReversalError } from '../services/reversal.js';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = '/var/www/tarsyn-core/uploads/invoices';

// ── Auto-increment invoice number ────────────────────────────────
async function nextInvoiceNumber(company_id) {
  const { rows } = await query(
    `SELECT COUNT(*) AS cnt FROM invoices WHERE company_id = $1`,
    [company_id]
  );
  const n = parseInt(rows[0].cnt, 10) + 1;
  return `INV-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
}

// ── Fetch active bank account for company ─────────────────────────
async function getActiveBankAccount(company_id) {
  const { rows } = await query(
    `SELECT * FROM bank_accounts WHERE company_id = $1 AND is_active = true ORDER BY created_at ASC LIMIT 1`,
    [company_id]
  );
  return rows[0] || null;
}

// ── Generate PDF ─────────────────────────────────────────────────
async function generateInvoicePDF(invoice, items, isProforma = false, bankAccount = null) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const filename = `${invoice.invoice_number}-${Date.now()}.pdf`;
  const filepath = path.join(UPLOADS_DIR, filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    // ── Header ──────────────────────────────────────────────────
    doc.fontSize(20).font('Helvetica-Bold')
       .text('NATEJ RUBBER INDUSTRIAL COMPANY', 50, 50, { align: 'center' });
    doc.fontSize(10).font('Helvetica')
       .text('Saudi Arabia', { align: 'center' });

    doc.moveDown(0.5);
    doc.fontSize(16).font('Helvetica-Bold')
       .fillColor('#1a5276')
       .text(isProforma ? 'PROFORMA INVOICE' : 'INVOICE', { align: 'center' });
    doc.fillColor('#000000');

    // ── Divider ─────────────────────────────────────────────────
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    // ── Invoice Meta ────────────────────────────────────────────
    const leftX = 50;
    const rightX = 320;
    const yMeta = doc.y;

    doc.fontSize(9).font('Helvetica-Bold').text('Invoice No:', leftX, yMeta);
    doc.font('Helvetica').text(invoice.invoice_number, leftX + 70, yMeta);

    doc.font('Helvetica-Bold').text('Date:', leftX, yMeta + 14);
    doc.font('Helvetica').text(invoice.invoice_date || '', leftX + 70, yMeta + 14);

    if (isProforma) {
      doc.font('Helvetica-Bold').text('Validity Date:', leftX, yMeta + 28);
      doc.font('Helvetica').text(invoice.due_date || '', leftX + 70, yMeta + 28);
    } else {
      doc.font('Helvetica-Bold').text('Due Date:', leftX, yMeta + 28);
      doc.font('Helvetica').text(invoice.due_date || '', leftX + 70, yMeta + 28);
    }

    doc.font('Helvetica-Bold').text('Currency:', leftX, yMeta + 42);
    doc.font('Helvetica').text(invoice.currency || 'USD', leftX + 70, yMeta + 42);

    // ── Client info ─────────────────────────────────────────────
    doc.font('Helvetica-Bold').text('Bill To:', rightX, yMeta);
    doc.font('Helvetica').text(invoice.client_name || 'N/A', rightX, yMeta + 14);
    if (invoice.client_country) {
      doc.text(invoice.client_country, rightX, yMeta + 28);
    }

    doc.moveDown(4);

    // ── Shipment Details ────────────────────────────────────────
    if (invoice.bl_number || invoice.vessel_name || invoice.port_of_loading) {
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#cccccc');
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica-Bold').text('SHIPMENT DETAILS');
      doc.moveDown(0.3);
      const shipY = doc.y;
      doc.fontSize(9);
      if (invoice.bl_number) {
        doc.font('Helvetica-Bold').text('B/L Number:', leftX, shipY);
        doc.font('Helvetica').text(invoice.bl_number, leftX + 80, shipY);
      }
      if (invoice.bl_date) {
        doc.font('Helvetica-Bold').text('B/L Date:', leftX, shipY + 14);
        doc.font('Helvetica').text(invoice.bl_date, leftX + 80, shipY + 14);
      }
      if (invoice.vessel_name) {
        doc.font('Helvetica-Bold').text('Vessel:', rightX, shipY);
        doc.font('Helvetica').text(invoice.vessel_name, rightX + 60, shipY);
      }
      if (invoice.port_of_loading) {
        doc.font('Helvetica-Bold').text('Port of Loading:', rightX, shipY + 14);
        doc.font('Helvetica').text(invoice.port_of_loading, rightX + 100, shipY + 14);
      }
      if (invoice.port_of_discharge) {
        doc.font('Helvetica-Bold').text('Port of Discharge:', rightX, shipY + 28);
        doc.font('Helvetica').text(invoice.port_of_discharge, rightX + 110, shipY + 28);
      }
      doc.moveDown(3.5);
    }

    // ── Items Table ─────────────────────────────────────────────
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    const tableY = doc.y + 5;

    // Table header
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#ffffff');
    doc.rect(50, tableY, 495, 18).fill('#1a5276');
    doc.fillColor('#ffffff')
       .text('Description', 55, tableY + 4, { width: 200 })
       .text('Qty (MT)', 265, tableY + 4, { width: 70, align: 'right' })
       .text('Unit Price', 345, tableY + 4, { width: 80, align: 'right' })
       .text('Total', 435, tableY + 4, { width: 100, align: 'right' });

    doc.fillColor('#000000');
    let rowY = tableY + 20;

    (items || []).forEach((item, i) => {
      if (i % 2 === 0) {
        doc.rect(50, rowY, 495, 18).fill('#f0f3f4');
        doc.fillColor('#000000');
      }
      doc.fontSize(9).font('Helvetica')
         .text(item.description || '', 55, rowY + 4, { width: 200 })
         .text(`${parseFloat(item.quantity || 0).toFixed(3)}`, 265, rowY + 4, { width: 70, align: 'right' })
         .text(`${invoice.currency || 'USD'} ${parseFloat(item.unit_price || 0).toFixed(2)}`, 345, rowY + 4, { width: 80, align: 'right' })
         .text(`${invoice.currency || 'USD'} ${parseFloat(item.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, 435, rowY + 4, { width: 100, align: 'right' });
      rowY += 20;
    });

    doc.moveTo(50, rowY).lineTo(545, rowY).stroke();

    // Totals
    rowY += 8;
    doc.fontSize(9).font('Helvetica')
       .text('Subtotal:', 345, rowY, { width: 90, align: 'right' })
       .text(`${invoice.currency || 'USD'} ${parseFloat(invoice.subtotal || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, 435, rowY, { width: 100, align: 'right' });

    if (parseFloat(invoice.tax_amount || 0) > 0) {
      rowY += 16;
      doc.text('Tax:', 345, rowY, { width: 90, align: 'right' })
         .text(`${invoice.currency || 'USD'} ${parseFloat(invoice.tax_amount || 0).toFixed(2)}`, 435, rowY, { width: 100, align: 'right' });
    }

    rowY += 16;
    doc.font('Helvetica-Bold').fontSize(10)
       .text('TOTAL:', 345, rowY, { width: 90, align: 'right' })
       .text(`${invoice.currency || 'USD'} ${parseFloat(invoice.total_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, 435, rowY, { width: 100, align: 'right' });

    // ── Payment Terms ────────────────────────────────────────────
    if (invoice.payment_terms) {
      doc.moveDown(2);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#cccccc');
      doc.moveDown(0.5);
      doc.fontSize(9).font('Helvetica-Bold').text('Payment Terms:');
      doc.font('Helvetica').text(invoice.payment_terms);
    }

    // ── Bank Details ─────────────────────────────────────────────
    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#cccccc');
    doc.moveDown(0.5);
    doc.fontSize(9).font('Helvetica-Bold').text('Bank Details for Payment:');
    if (bankAccount) {
      doc.font('Helvetica');
      if (bankAccount.bank_name)      doc.text(`Bank Name: ${bankAccount.bank_name}`);
      if (bankAccount.account_name)   doc.text(`Account Name: ${bankAccount.account_name}`);
      if (bankAccount.account_number) doc.text(`Account Number: ${bankAccount.account_number}`);
      if (bankAccount.iban)           doc.text(`IBAN: ${bankAccount.iban}`);
      if (bankAccount.swift_code)     doc.text(`SWIFT/BIC: ${bankAccount.swift_code}`);
      if (bankAccount.branch)         doc.text(`Branch: ${bankAccount.branch}`);
      if (bankAccount.currency)       doc.text(`Currency: ${bankAccount.currency}`);
    } else {
      doc.font('Helvetica')
         .text('Bank Name: NATEJ RUBBER INDUSTRIAL COMPANY')
         .text('Account Name: NATEJ RUBBER INDUSTRIAL COMPANY')
         .text('IBAN: [Contact management for bank details]')
         .text('SWIFT/BIC: [Contact management for bank details]');
    }

    // ── Notes ────────────────────────────────────────────────────
    if (invoice.notes) {
      doc.moveDown(1);
      doc.fontSize(9).font('Helvetica-Bold').text('Notes:');
      doc.font('Helvetica').text(invoice.notes);
    }

    // ── Footer ───────────────────────────────────────────────────
    doc.fontSize(8).font('Helvetica').fillColor('#888888')
       .text('This document was generated electronically by NATEJ ERP System.', 50, 760, { align: 'center' });

    doc.end();
    stream.on('finish', () => resolve(`/uploads/invoices/${filename}`));
    stream.on('error', reject);
  });
}

export default async function invoicesRoutes(app) {

  // ── GET /api/invoices ─────────────────────────────────────────
  app.get('/invoices', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { status, client_id } = request.query;

    const conditions = ['i.company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (status)    { conditions.push(`i.status = $${p++}`); params.push(status); }
    if (client_id) { conditions.push(`i.client_id = $${p++}`); params.push(client_id); }

    const { rows } = await query(
      `SELECT i.*,
              cl.name AS client_name,
              cl.country AS client_country,
              so.order_number AS sales_order_number,
              so.bl_number AS so_bl_number
       FROM invoices i
       LEFT JOIN clients cl ON cl.id = i.client_id
       LEFT JOIN sales_orders so ON so.id = i.sales_order_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY i.created_at DESC`,
      params
    );
    return { data: rows };
  });

  // ── POST /api/invoices ────────────────────────────────────────
  app.post('/invoices', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['invoice_date'],
        properties: {
          sales_order_id:    { type: 'string' },
          client_id:         { type: 'string' },
          invoice_date:      { type: 'string' },
          due_date:          { type: 'string' },
          currency:          { type: 'string' },
          payment_terms:     { type: 'string' },
          bl_number:         { type: 'string' },
          bl_date:           { type: 'string' },
          vessel_name:       { type: 'string' },
          port_of_loading:   { type: 'string' },
          port_of_discharge: { type: 'string' },
          notes:             { type: 'string' },
          tax_amount:        { type: 'number' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['description'],
              properties: {
                description: { type: 'string' },
                quantity:    { type: 'number' },
                unit:        { type: 'string' },
                unit_price:  { type: 'number' },
                total:       { type: 'number' },
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { company_id } = request.user;
    const b = request.body;

    // Pull data from sales order if provided
    let so = null;
    if (b.sales_order_id) {
      const { rows } = await query(
        `SELECT so.*, cl.name AS client_name, cl.country AS client_country
         FROM sales_orders so
         LEFT JOIN clients cl ON cl.id = so.client_id
         WHERE so.id = $1 AND so.company_id = $2`,
        [b.sales_order_id, company_id]
      );
      so = rows[0] || null;
    }

    const invoice_number = await nextInvoiceNumber(company_id);
    const items = b.items || [];
    const subtotal = items.reduce((s, i) => s + parseFloat(i.total || 0), 0);
    const tax_amount = parseFloat(b.tax_amount || 0);
    const total_amount = subtotal + tax_amount;

    const { rows } = await query(
      `INSERT INTO invoices
         (company_id, invoice_number, sales_order_id, client_id,
          invoice_date, due_date, subtotal, tax_amount, total_amount,
          currency, payment_terms, bl_number, bl_date, vessel_name,
          port_of_loading, port_of_discharge, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'draft')
       RETURNING *`,
      [
        company_id,
        invoice_number,
        b.sales_order_id || so?.id || null,
        b.client_id || so?.client_id || null,
        b.invoice_date,
        b.due_date || so?.payment_due_date || null,
        subtotal,
        tax_amount,
        total_amount,
        b.currency || so?.currency || 'USD',
        b.payment_terms || null,
        b.bl_number || so?.bl_number || null,
        b.bl_date || so?.bl_date || null,
        b.vessel_name || so?.vessel_name || null,
        b.port_of_loading || so?.port_of_loading || null,
        b.port_of_discharge || so?.port_of_discharge || null,
        b.notes || null,
      ]
    );
    const invoice = rows[0];
    invoice.client_name = so?.client_name || null;
    invoice.client_country = so?.client_country || null;

    // Insert items
    for (const item of items) {
      await query(
        `INSERT INTO invoice_items (invoice_id, description, quantity, unit, unit_price, total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [invoice.id, item.description, item.quantity || null, item.unit || 'MT', item.unit_price || null, item.total || null]
      );
    }

    return reply.status(201).send(invoice);
  });

  // ── GET /api/invoices/:id ─────────────────────────────────────
  app.get('/invoices/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;

    const { rows } = await query(
      `SELECT i.*,
              cl.name AS client_name,
              cl.country AS client_country,
              so.order_number AS sales_order_number,
              so.bl_number AS so_bl_number
       FROM invoices i
       LEFT JOIN clients cl ON cl.id = i.client_id
       LEFT JOIN sales_orders so ON so.id = i.sales_order_id
       WHERE i.id = $1 AND i.company_id = $2`,
      [id, company_id]
    );
    if (!rows.length) return reply.status(404).send({ error: 'Invoice not found' });
    const invoice = rows[0];

    const { rows: items } = await query(
      `SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY created_at`,
      [id]
    );
    invoice.items = items;
    return invoice;
  });

  // ── PATCH /api/invoices/:id ───────────────────────────────────
  app.patch('/invoices/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const allowed = ['status', 'payment_received_date', 'due_date', 'notes', 'payment_terms',
                     'bl_number', 'bl_date', 'vessel_name', 'port_of_loading', 'port_of_discharge'];
    const updates = [];
    const params = [];
    let p = 1;

    for (const key of allowed) {
      if (request.body[key] !== undefined) {
        updates.push(`${key} = $${p++}`);
        params.push(request.body[key]);
      }
    }
    if (!updates.length) return reply.status(400).send({ error: 'No valid fields' });
    updates.push(`updated_at = NOW()`);
    params.push(id, company_id);

    const { rows } = await query(
      `UPDATE invoices SET ${updates.join(', ')} WHERE id = $${p++} AND company_id = $${p} RETURNING *`,
      params
    );
    if (!rows.length) return reply.status(404).send({ error: 'Invoice not found' });
    return rows[0];
  });

  // ── POST /api/invoices/:id/generate-pdf ───────────────────────
  app.post('/invoices/:id/generate-pdf', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;

    const { rows } = await query(
      `SELECT i.*,
              cl.name AS client_name,
              cl.country AS client_country
       FROM invoices i
       LEFT JOIN clients cl ON cl.id = i.client_id
       WHERE i.id = $1 AND i.company_id = $2`,
      [id, company_id]
    );
    if (!rows.length) return reply.status(404).send({ error: 'Invoice not found' });
    const invoice = rows[0];

    const { rows: items } = await query(
      `SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY created_at`,
      [id]
    );

    try {
      const bankAccount = await getActiveBankAccount(company_id);
      const pdfUrl = await generateInvoicePDF(invoice, items, false, bankAccount);
      await query(`UPDATE invoices SET pdf_url = $1, updated_at = NOW() WHERE id = $2`, [pdfUrl, id]);
      return { pdf_url: pdfUrl };
    } catch (err) {
      return reply.status(500).send({ error: 'PDF generation failed: ' + err.message });
    }
  });

  // ── GET /api/invoices/:id/download ────────────────────────────
  app.get('/invoices/:id/download', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;

    const { rows } = await query(
      `SELECT pdf_url FROM invoices WHERE id = $1 AND company_id = $2`,
      [id, company_id]
    );
    if (!rows.length || !rows[0].pdf_url) {
      return reply.status(404).send({ error: 'PDF not found. Generate it first.' });
    }

    const filepath = path.join('/var/www/tarsyn-core', rows[0].pdf_url);
    if (!fs.existsSync(filepath)) {
      return reply.status(404).send({ error: 'PDF file missing on disk.' });
    }

    const filename = path.basename(filepath);
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(fs.createReadStream(filepath));
  });

  // ── Proforma: POST /api/invoices/proforma/generate ───────────
  app.post('/invoices/proforma/generate', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['rfq_id', 'invoice_date'],
        properties: {
          rfq_id:            { type: 'string' },
          invoice_date:      { type: 'string' },
          due_date:          { type: 'string' },
          notes:             { type: 'string' },
          tax_amount:        { type: 'number' },
        }
      }
    }
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { rfq_id, invoice_date, due_date, notes, tax_amount = 0 } = request.body;

    const { rows } = await query(
      `SELECT r.*,
              cl.name AS client_name,
              cl.country AS client_country
       FROM rfqs r
       LEFT JOIN clients cl ON cl.id = r.client_id
       WHERE r.id = $1 AND r.company_id = $2`,
      [rfq_id, company_id]
    );
    if (!rows.length) return reply.status(404).send({ error: 'RFQ not found' });
    const rfq = rows[0];

    const subtotal = parseFloat(rfq.quantity_mt || 0) * parseFloat(rfq.price_per_mt || 0);
    const total_amount = subtotal + parseFloat(tax_amount);

    const proforma = {
      id: rfq_id,
      invoice_number: `PRF-${rfq.rfq_number || rfq_id.substring(0, 8)}`,
      invoice_date,
      due_date: due_date || rfq.validity_date,
      client_name: rfq.client_name,
      client_country: rfq.client_country,
      currency: rfq.currency || 'USD',
      subtotal,
      tax_amount,
      total_amount,
      notes,
      bl_number: null,
      bl_date: null,
      vessel_name: null,
      port_of_loading: null,
      port_of_discharge: null,
      payment_terms: null,
    };

    const items = [{
      description: rfq.product_description || 'Rubber Products',
      quantity: rfq.quantity_mt,
      unit: 'MT',
      unit_price: rfq.price_per_mt,
      total: subtotal,
    }];

    const PROFORMA_DIR = '/var/www/tarsyn-core/uploads/proformas';
    fs.mkdirSync(PROFORMA_DIR, { recursive: true });

    // Generate PDF to proformas dir but reuse same function
    try {
      const bankAccount = await getActiveBankAccount(company_id);
      const pdfUrl = await generateProformaPDF(proforma, items, PROFORMA_DIR, bankAccount);
      await query(
        `UPDATE rfqs SET proforma_pdf_url = $1 WHERE id = $2 AND company_id = $3`,
        [pdfUrl, rfq_id, company_id]
      );
      return { pdf_url: pdfUrl, proforma_number: proforma.invoice_number };
    } catch (err) {
      return reply.status(500).send({ error: 'Proforma PDF generation failed: ' + err.message });
    }
  });

  // ── POST /api/invoices/:id/cancel ────────────────────────────
  // Cancel a draft invoice. Refuses if already sent / paid / reversed.
  app.post('/invoices/:id/cancel', {
    preHandler: [app.authenticate],
    schema: { body: { type: 'object', properties: { reason: { type: 'string' } } } },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;
    const reason = request.body?.reason ?? 'Cancelled before send';
    try {
      const result = await cancelDocument({
        table: 'invoices',
        id,
        companyId: company_id,
        userId: user_id,
        reason,
        cancellableStatuses: ['draft'],
      });
      return reply.status(200).send(result);
    } catch (err) { return sendReversalError(reply, err); }
  });

  // ── POST /api/invoices/:id/reverse ───────────────────────────
  // Reverse a sent / paid invoice — equivalent to issuing a credit
  // note. Stamps the row terminal. If the invoice was paid, the
  // payment_received_date and payment_status are NOT cleared here
  // — the operator should also reverse the corresponding fund
  // transaction so the wallet balance is correct.
  app.post('/invoices/:id/reverse', {
    preHandler: [app.authenticate],
    schema: { body: { type: 'object', properties: { reason: { type: 'string' } } } },
  }, async (request, reply) => {
    const { company_id, sub: user_id } = request.user;
    const { id } = request.params;
    const reason = request.body?.reason ?? 'Invoice reversed (credit note)';
    try {
      const result = await reverseDocument({
        table: 'invoices',
        id,
        companyId: company_id,
        userId: user_id,
        reason,
        extraStatus: { status: 'reversed' },
      });
      return reply.status(200).send(result);
    } catch (err) { return sendReversalError(reply, err); }
  });
}

async function generateProformaPDF(invoice, items, dir, bankAccount = null) {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `PRF-${invoice.invoice_number}-${Date.now()}.pdf`;
  const filepath = path.join(dir, filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    doc.fontSize(20).font('Helvetica-Bold')
       .text('NATEJ RUBBER INDUSTRIAL COMPANY', 50, 50, { align: 'center' });
    doc.fontSize(10).font('Helvetica')
       .text('Saudi Arabia', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(16).font('Helvetica-Bold')
       .fillColor('#1a5276')
       .text('PROFORMA INVOICE', { align: 'center' });
    doc.fillColor('#000000');
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    const leftX = 50;
    const rightX = 320;
    const yMeta = doc.y;

    doc.fontSize(9).font('Helvetica-Bold').text('Proforma No:', leftX, yMeta);
    doc.font('Helvetica').text(invoice.invoice_number, leftX + 80, yMeta);
    doc.font('Helvetica-Bold').text('Date:', leftX, yMeta + 14);
    doc.font('Helvetica').text(invoice.invoice_date || '', leftX + 80, yMeta + 14);
    doc.font('Helvetica-Bold').text('Valid Until:', leftX, yMeta + 28);
    doc.font('Helvetica').text(invoice.due_date || '', leftX + 80, yMeta + 28);
    doc.font('Helvetica-Bold').text('Currency:', leftX, yMeta + 42);
    doc.font('Helvetica').text(invoice.currency || 'USD', leftX + 80, yMeta + 42);

    doc.font('Helvetica-Bold').text('Prepared For:', rightX, yMeta);
    doc.font('Helvetica').text(invoice.client_name || 'N/A', rightX, yMeta + 14);
    if (invoice.client_country) doc.text(invoice.client_country, rightX, yMeta + 28);

    doc.moveDown(4);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    const tableY = doc.y + 5;

    doc.fontSize(9).font('Helvetica-Bold').fillColor('#ffffff');
    doc.rect(50, tableY, 495, 18).fill('#1a5276');
    doc.fillColor('#ffffff')
       .text('Description', 55, tableY + 4, { width: 200 })
       .text('Qty (MT)', 265, tableY + 4, { width: 70, align: 'right' })
       .text('Unit Price', 345, tableY + 4, { width: 80, align: 'right' })
       .text('Total', 435, tableY + 4, { width: 100, align: 'right' });

    doc.fillColor('#000000');
    let rowY = tableY + 20;

    (items || []).forEach((item, i) => {
      if (i % 2 === 0) { doc.rect(50, rowY, 495, 18).fill('#f0f3f4'); doc.fillColor('#000000'); }
      doc.fontSize(9).font('Helvetica')
         .text(item.description || '', 55, rowY + 4, { width: 200 })
         .text(`${parseFloat(item.quantity || 0).toFixed(3)}`, 265, rowY + 4, { width: 70, align: 'right' })
         .text(`${invoice.currency || 'USD'} ${parseFloat(item.unit_price || 0).toFixed(2)}`, 345, rowY + 4, { width: 80, align: 'right' })
         .text(`${invoice.currency || 'USD'} ${parseFloat(item.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, 435, rowY + 4, { width: 100, align: 'right' });
      rowY += 20;
    });

    doc.moveTo(50, rowY).lineTo(545, rowY).stroke();
    rowY += 8;
    doc.fontSize(9).font('Helvetica')
       .text('Subtotal:', 345, rowY, { width: 90, align: 'right' })
       .text(`${invoice.currency || 'USD'} ${parseFloat(invoice.subtotal || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, 435, rowY, { width: 100, align: 'right' });
    if (parseFloat(invoice.tax_amount || 0) > 0) {
      rowY += 16;
      doc.text('Tax:', 345, rowY, { width: 90, align: 'right' })
         .text(`${invoice.currency || 'USD'} ${parseFloat(invoice.tax_amount || 0).toFixed(2)}`, 435, rowY, { width: 100, align: 'right' });
    }
    rowY += 16;
    doc.font('Helvetica-Bold').fontSize(10)
       .text('TOTAL:', 345, rowY, { width: 90, align: 'right' })
       .text(`${invoice.currency || 'USD'} ${parseFloat(invoice.total_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, 435, rowY, { width: 100, align: 'right' });

    if (invoice.notes) {
      doc.moveDown(2);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#cccccc');
      doc.moveDown(0.5);
      doc.fontSize(9).font('Helvetica-Bold').text('Notes:');
      doc.font('Helvetica').text(invoice.notes);
    }

    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#cccccc');
    doc.moveDown(0.5);
    doc.fontSize(9).font('Helvetica-Bold').text('Bank Details for Payment:');
    if (bankAccount) {
      doc.font('Helvetica');
      if (bankAccount.bank_name)      doc.text(`Bank Name: ${bankAccount.bank_name}`);
      if (bankAccount.account_name)   doc.text(`Account Name: ${bankAccount.account_name}`);
      if (bankAccount.account_number) doc.text(`Account Number: ${bankAccount.account_number}`);
      if (bankAccount.iban)           doc.text(`IBAN: ${bankAccount.iban}`);
      if (bankAccount.swift_code)     doc.text(`SWIFT/BIC: ${bankAccount.swift_code}`);
      if (bankAccount.branch)         doc.text(`Branch: ${bankAccount.branch}`);
      if (bankAccount.currency)       doc.text(`Currency: ${bankAccount.currency}`);
    } else {
      doc.font('Helvetica')
         .text('Bank Name: NATEJ RUBBER INDUSTRIAL COMPANY')
         .text('Account Name: NATEJ RUBBER INDUSTRIAL COMPANY')
         .text('IBAN: [Contact management for bank details]')
         .text('SWIFT/BIC: [Contact management for bank details]');
    }

    doc.fontSize(8).font('Helvetica').fillColor('#888888')
       .text('This is a Proforma Invoice. It does not constitute a tax invoice.', 50, 760, { align: 'center' });

    doc.end();
    stream.on('finish', () => resolve(`/uploads/proformas/${filename}`));
    stream.on('error', reject);
  });
}
