import { query } from '../../db.js';

export default async function suppliersRoutes(app) {

  // ── GET /api/procurement/suppliers ───────────────────────────
  app.get('/suppliers', {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          is_active: { type: 'boolean' },
          category:  { type: 'string' },
          limit:     { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset:    { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (request, _reply) => {
    const { company_id } = request.user;
    const { is_active, category, limit, offset } = request.query;

    const conditions = ['company_id = $1'];
    const params = [company_id];
    let p = 2;

    if (is_active !== undefined) { conditions.push(`is_active = $${p++}`); params.push(is_active); }
    if (category)                { conditions.push(`category  = $${p++}`); params.push(category);  }

    params.push(limit, offset);

    const { rows } = await query(
      `SELECT id, name, category, contact_name, contact_phone,
              email, address, bank_name, bank_account_number, iban, swift_code, services_provided,
              current_price, currency, supplier_code, credit_days, payment_term_type,
              payment_terms, is_active, created_at
       FROM suppliers
       WHERE ${conditions.join(' AND ')}
       ORDER BY name ASC
       LIMIT $${p} OFFSET $${p + 1}`,
      params
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS total FROM suppliers WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2)
    );

    return { data: rows, total: parseInt(countRows[0].total, 10), limit, offset };
  });

  // ── POST /api/procurement/suppliers ──────────────────────────
  app.post('/suppliers', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name:             { type: 'string', minLength: 1 },
          category:         { type: 'string' },
          contact_name:     { type: 'string' },
          contact_phone:    { type: 'string' },
          contact_person:   { type: 'string' },
          phone:            { type: 'string' },
          payment_terms:    { type: 'string' },
          current_price:    { type: 'number' },
          currency:         { type: 'string' },
          supplier_code:    { type: 'string' },
          credit_days:      { type: 'integer' },
          payment_term_type:{ type: 'string' },
          email:            { type: 'string' },
          address:          { type: 'string' },
          bank_name:        { type: 'string' },
          bank_account_number: { type: 'string' },
          iban:             { type: 'string' },
          swift_code:       { type: 'string' },
          services_provided:{ type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const {
      name,
      category: categoryRaw,
      category_ids,
      tag_ids,
      contact_name,
      contact_phone,
      contact_person,
      phone,
      payment_terms,
      current_price,
      currency,
      supplier_code,
      credit_days,
      payment_term_type,
      email,
      address,
      bank_name,
      bank_account_number,
      iban,
      swift_code,
      services_provided,
    } = request.body;

    const resolvedContactName = contact_name ?? contact_person ?? null;
    const resolvedContactPhone = contact_phone ?? phone ?? null;
    // Accept either a single category string or first item of category_ids/tag_ids array
    const effectiveTagIds = Array.isArray(tag_ids) ? tag_ids : (Array.isArray(category_ids) ? category_ids : []);
    const category = effectiveTagIds.length > 0
      ? effectiveTagIds[0]
      : (categoryRaw ?? null);

    const { rows } = await query(
      `INSERT INTO suppliers
         (company_id, name, category, contact_name, contact_phone, payment_terms, current_price, currency, supplier_code, credit_days, payment_term_type, email, address, bank_name, bank_account_number, iban, swift_code, services_provided)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        company_id,
        name.trim(),
        category ?? null,
        resolvedContactName,
        resolvedContactPhone,
        payment_terms ?? null,
        current_price ?? 0,
        currency ?? 'SAR',
        supplier_code ?? null,
        credit_days ?? 0,
        payment_term_type ?? 'cash',
        email ?? null,
        address ?? null,
        bank_name ?? null,
        bank_account_number ?? null,
        iban ?? null,
        swift_code ?? null,
        services_provided ?? null,
      ]
    );

    const supplier = rows[0];

    // Insert tag mappings if tag_ids provided
    if (effectiveTagIds.length > 0) {
      for (const tagId of effectiveTagIds) {
        await query(
          `INSERT INTO supplier_tag_mapping (supplier_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [supplier.id, tagId]
        ).catch(() => {}); // ignore if tag_id is not a valid UUID
      }
    }

    return reply.status(201).send(supplier);
  });

  // ── PATCH /api/procurement/suppliers/:id ─────────────────────────
  app.patch('/suppliers/:id', {
    preHandler: [app.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          name:              { type: 'string' },
          category:          { type: 'string' },
          contact_name:      { type: 'string' },
          contact_phone:     { type: 'string' },
          contact_person:    { type: 'string' },
          phone:             { type: 'string' },
          payment_terms:     { type: 'string' },
          current_price:     { type: 'number' },
          currency:          { type: 'string' },
          supplier_code:     { type: 'string' },
          credit_days:       { type: 'integer' },
          payment_term_type: { type: 'string' },
          email:             { type: 'string' },
          address:           { type: 'string' },
          bank_name:         { type: 'string' },
          bank_account_number: { type: 'string' },
          iban:              { type: 'string' },
          swift_code:        { type: 'string' },
          services_provided: { type: 'string' },
          is_active:         { type: 'boolean' },
          status:            { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const body = request.body ?? {};

    const updates = [];
    const params = [company_id, id];
    let p = 3;

    const setField = (column, value) => {
      updates.push(`${column} = $${p++}`);
      params.push(value);
    };

    if (body.name !== undefined) setField('name', body.name.trim());
    const resolvedCategory = Array.isArray(body.tag_ids) && body.tag_ids.length > 0
      ? body.tag_ids[0]
      : Array.isArray(body.category_ids) && body.category_ids.length > 0
        ? body.category_ids[0]
        : (body.category !== undefined ? (body.category || null) : undefined);
    if (resolvedCategory !== undefined) setField('category', resolvedCategory);
    if (body.contact_name !== undefined || body.contact_person !== undefined) {
      setField('contact_name', body.contact_name ?? body.contact_person ?? null);
    }
    if (body.contact_phone !== undefined || body.phone !== undefined) {
      setField('contact_phone', body.contact_phone ?? body.phone ?? null);
    }
    if (body.payment_terms !== undefined) setField('payment_terms', body.payment_terms || null);
    if (body.current_price !== undefined) setField('current_price', body.current_price ?? 0);
    if (body.currency !== undefined) setField('currency', body.currency || 'SAR');
    if (body.supplier_code !== undefined) setField('supplier_code', body.supplier_code || null);
    if (body.credit_days !== undefined) setField('credit_days', body.credit_days ?? 0);
    if (body.payment_term_type !== undefined) setField('payment_term_type', body.payment_term_type || 'cash');
    if (body.email !== undefined) setField('email', body.email || null);
    if (body.address !== undefined) setField('address', body.address || null);
    if (body.bank_name !== undefined || body.bankName !== undefined) setField('bank_name', body.bank_name ?? body.bankName ?? null);
    if (body.bank_account_number !== undefined || body.bankAccountNumber !== undefined) setField('bank_account_number', body.bank_account_number ?? body.bankAccountNumber ?? null);
    if (body.iban !== undefined) setField('iban', body.iban || null);
    if (body.swift_code !== undefined || body.swiftCode !== undefined) setField('swift_code', body.swift_code ?? body.swiftCode ?? null);
    if (body.services_provided !== undefined || body.servicesProvided !== undefined) setField('services_provided', body.services_provided ?? body.servicesProvided ?? null);
    if (body.is_active !== undefined) setField('is_active', body.is_active);
    if (body.status !== undefined) setField('is_active', body.status === 'active');

    if (!updates.length && body.tag_ids === undefined && body.category_ids === undefined) {
      return reply.status(400).send({ error: 'No valid fields to update' });
    }

    let supplier;
    if (updates.length > 0) {
      const { rows } = await query(
        `UPDATE suppliers
         SET ${updates.join(', ')}
         WHERE company_id = $1 AND id = $2
         RETURNING *`,
        params
      );
      if (!rows.length) return reply.status(404).send({ error: 'Supplier not found' });
      supplier = rows[0];
    } else {
      const { rows } = await query(
        `SELECT * FROM suppliers WHERE company_id = $1 AND id = $2`,
        [company_id, id]
      );
      if (!rows.length) return reply.status(404).send({ error: 'Supplier not found' });
      supplier = rows[0];
    }

    // Update tag mappings if tag_ids or category_ids provided
    const newTagIds = Array.isArray(body.tag_ids) ? body.tag_ids : (Array.isArray(body.category_ids) ? body.category_ids : null);
    if (newTagIds !== null) {
      await query(`DELETE FROM supplier_tag_mapping WHERE supplier_id = $1`, [id]);
      for (const tagId of newTagIds) {
        await query(
          `INSERT INTO supplier_tag_mapping (supplier_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [id, tagId]
        ).catch(() => {});
      }
    }

    return supplier;
  });

}
