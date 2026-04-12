import bcrypt from 'bcryptjs';
import { query } from '../db.js';

export default async function adminRoutes(app) {

  // ── GET /users ─────────────────────────────────────────────────
  app.get('/users', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT u.id, u.email, u.full_name, u.created_at,
              ur.role,
              json_agg(json_build_object('module', mp.module, 'access_level', mp.access_level))
                FILTER (WHERE mp.module IS NOT NULL) AS permissions
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
       LEFT JOIN module_permissions mp ON mp.user_id = u.id AND mp.company_id = u.company_id
       WHERE u.company_id = $1
       GROUP BY u.id, u.email, u.full_name, u.created_at, ur.role
       ORDER BY u.created_at DESC`,
      [company_id]
    );
    return rows;
  });

  // ── POST /users ────────────────────────────────────────────────
  app.post('/users', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { email, password, full_name, role, permissions } = request.body;

    const password_hash = await bcrypt.hash(password, 12);

    const { rows: userRows } = await query(
      `INSERT INTO users (company_id, email, full_name, password_hash, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, email, full_name, created_at`,
      [company_id, email, full_name, password_hash]
    );
    const user = userRows[0];

    await query(
      `INSERT INTO user_roles (user_id, company_id, role) VALUES ($1, $2, $3)`,
      [user.id, company_id, role]
    );

    if (Array.isArray(permissions) && permissions.length > 0) {
      for (const perm of permissions) {
        if (perm.access_level !== 'none') {
          await query(
            `INSERT INTO module_permissions (user_id, company_id, module, access_level)
             VALUES ($1, $2, $3, $4)`,
            [user.id, company_id, perm.module, perm.access_level]
          );
        }
      }
    }

    return { ...user, role, permissions: permissions || [] };
  });

  // ── PATCH /users/:id/role ──────────────────────────────────────
  app.patch('/users/:id/role', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { role } = request.body;

    await query(
      `DELETE FROM user_roles WHERE user_id = $1 AND company_id = $2`,
      [id, company_id]
    );
    await query(
      `INSERT INTO user_roles (user_id, company_id, role) VALUES ($1, $2, $3)`,
      [id, company_id, role]
    );

    return { success: true };
  });

  // ── PATCH /users/:id/permissions ───────────────────────────────
  app.patch('/users/:id/permissions', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { module, access_level } = request.body;

    await query(
      `INSERT INTO module_permissions (user_id, company_id, module, access_level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, company_id, module) DO UPDATE SET access_level = EXCLUDED.access_level`,
      [id, company_id, module, access_level]
    );

    return { success: true };
  });

  // ── POST /users/:id/change-password ───────────────────────────
  app.post('/users/:id/change-password', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, role } = request.user;
    const { id } = request.params;
    const { new_password } = request.body;

    if (role !== 'admin' && role !== 'ceo') {
      return reply.status(403).send({ error: 'Forbidden — admin or CEO role required' });
    }

    const password_hash = await bcrypt.hash(new_password, 12);

    await query(
      `UPDATE users SET password_hash = $1 WHERE id = $2 AND company_id = $3`,
      [password_hash, id, company_id]
    );

    return { success: true };
  });

  // ── GET /email-templates ───────────────────────────────────────
  app.get('/email-templates', { preHandler: [app.authenticate] }, async (request, reply) => {
    return [];
  });

  // ── PATCH /email-templates/:id ─────────────────────────────────
  app.patch('/email-templates/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    return { success: true };
  });

  // ── GET /email-notification-settings ──────────────────────────
  app.get('/email-notification-settings', { preHandler: [app.authenticate] }, async (request, reply) => {
    return [];
  });

  // ── PATCH /email-notification-settings/:notification_type ──────
  app.patch('/email-notification-settings/:notification_type', { preHandler: [app.authenticate] }, async (request, reply) => {
    return { success: true };
  });

  // ── GET /inventory-items ───────────────────────────────────────
  app.get('/inventory-items', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT id, company_id, item_type, quantity_mt, last_updated
       FROM inventory_items
       WHERE company_id = $1
       ORDER BY item_type`,
      [company_id]
    );
    return rows;
  });

  // ── PATCH /inventory-items/:id ─────────────────────────────────
  app.patch('/inventory-items/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { quantity_mt } = request.body;

    const setClauses = [];
    const values = [];
    let idx = 1;

    if (quantity_mt !== undefined) {
      setClauses.push(`quantity_mt = $${idx++}`);
      values.push(quantity_mt);
    }

    if (setClauses.length === 0) {
      return { success: true };
    }

    values.push(id, company_id);
    await query(
      `UPDATE inventory_items SET ${setClauses.join(', ')}, last_updated = now()
       WHERE id = $${idx++} AND company_id = $${idx}`,
      values
    );

    return { success: true };
  });

  // ── GET /balances ──────────────────────────────────────────────
  app.get('/balances', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;

    const { rows: cards } = await query(
      `SELECT id, card_name, current_balance FROM corporate_cards WHERE company_id = $1 AND is_active = true`,
      [company_id]
    );

    const { rows: rmRows } = await query(
      `SELECT COALESCE(SUM(CASE WHEN transaction_type='inflow' THEN amount ELSE -amount END), 0) AS raw_material_cash
       FROM fund_transactions ft
       JOIN fund_accounts fa ON fa.id = ft.account_id
       WHERE ft.company_id = $1 AND ft.is_raw_material_payment = true`,
      [company_id]
    );

    const total_petty_cash = cards.reduce((sum, c) => sum + Number(c.current_balance), 0);
    const raw_material_cash = Number(rmRows[0]?.raw_material_cash || 0);

    return {
      corporate_cards: cards,
      raw_material_cash,
      total_petty_cash,
    };
  });

  // ── PATCH /corporate-cards/:id/balance ────────────────────────
  app.patch('/corporate-cards/:id/balance', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { id } = request.params;
    const { current_balance } = request.body;

    await query(
      `UPDATE corporate_cards SET current_balance = $1 WHERE id = $2 AND company_id = $3`,
      [current_balance, id, company_id]
    );

    return { success: true };
  });

  // ── POST /raw-material-adjustment ─────────────────────────────
  app.post('/raw-material-adjustment', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, sub: created_by } = request.user;
    const { amount, description } = request.body;

    const transaction_type = amount >= 0 ? 'inflow' : 'outflow';
    const abs_amount = Math.abs(amount);

    // Find or create a raw material fund account
    const { rows: accountRows } = await query(
      `SELECT id FROM fund_accounts WHERE company_id = $1 AND account_type = 'petty_cash' LIMIT 1`,
      [company_id]
    );

    if (accountRows.length === 0) {
      return reply.status(400).send({ error: 'No fund account found for this company' });
    }

    await query(
      `INSERT INTO fund_transactions (company_id, account_id, transaction_type, amount, description, created_by, is_raw_material_payment)
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [company_id, accountRows[0].id, transaction_type, abs_amount, description, created_by]
    );

    return { success: true };
  });

  // ── DELETE /reset/petty-cash ───────────────────────────────────
  app.delete('/reset/petty-cash', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, role } = request.user;

    if (role !== 'admin' && role !== 'ceo') {
      return reply.status(403).send({ error: 'Forbidden — admin or CEO role required' });
    }

    await query(
      `UPDATE corporate_cards SET current_balance = 0 WHERE company_id = $1`,
      [company_id]
    );

    return { success: true };
  });

  // ── DELETE /reset/transactions ─────────────────────────────────
  app.delete('/reset/transactions', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, role } = request.user;

    if (role !== 'admin' && role !== 'ceo') {
      return reply.status(403).send({ error: 'Forbidden — admin or CEO role required' });
    }

    await query(`DELETE FROM fund_transactions WHERE company_id = $1`, [company_id]);
    await query(`DELETE FROM fund_requests WHERE company_id = $1`, [company_id]);
    await query(`UPDATE corporate_cards SET current_balance = 0 WHERE company_id = $1`, [company_id]);

    return { success: true };
  });

  // ── DELETE /reset/stock-movements ─────────────────────────────
  app.delete('/reset/stock-movements', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, role } = request.user;

    if (role !== 'admin' && role !== 'ceo') {
      return reply.status(403).send({ error: 'Forbidden — admin or CEO role required' });
    }

    await query(`DELETE FROM inventory_logs WHERE company_id = $1`, [company_id]);
    await query(`DELETE FROM production_batches WHERE company_id = $1`, [company_id]);
    await query(`DELETE FROM production_orders WHERE company_id = $1`, [company_id]);
    await query(`UPDATE inventory_items SET quantity_mt = 0 WHERE company_id = $1`, [company_id]);

    return { success: true };
  });

  // ── DELETE /reset/all ──────────────────────────────────────────
  app.delete('/reset/all', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, role } = request.user;

    if (role !== 'admin' && role !== 'ceo') {
      return reply.status(403).send({ error: 'Forbidden — admin or CEO role required' });
    }

    const { confirm, reason } = request.body || {};

    if (confirm !== 'DELETE ALL') {
      return reply.status(400).send({ error: 'Confirmation text must be "DELETE ALL"' });
    }

    if (!reason || reason.trim().length < 10) {
      return reply.status(400).send({ error: 'A reason of at least 10 characters is required' });
    }

    const errors = [];

    const safeDelete = async (table) => {
      try {
        await query(`DELETE FROM ${table} WHERE company_id = $1`, [company_id]);
      } catch (e) {
        errors.push(`${table}: ${e.message}`);
      }
    };

    await safeDelete('notifications');
    await safeDelete('po_fulfillment_transactions');
    await safeDelete('inventory_logs');
    await safeDelete('raw_material_purchases');
    await safeDelete('supplier_payment_ledger');
    await safeDelete('fund_transactions');
    await safeDelete('fund_requests');
    await safeDelete('production_batches');
    await safeDelete('production_orders');

    try {
      await query(`UPDATE corporate_cards SET current_balance = 0 WHERE company_id = $1`, [company_id]);
    } catch (e) {
      errors.push(`corporate_cards reset: ${e.message}`);
    }

    try {
      await query(`UPDATE inventory_items SET quantity_mt = 0 WHERE company_id = $1`, [company_id]);
    } catch (e) {
      errors.push(`inventory_items reset: ${e.message}`);
    }

    if (errors.length > 0) {
      return { success: true, warnings: errors };
    }

    return { success: true };
  });
}
