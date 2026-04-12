import { query } from '../../db.js';
import nodemailer from 'nodemailer';

export default async function smtpRoutes(app) {

  // GET /api/email/smtp-config
  app.get('/smtp-config', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT id, smtp_host, smtp_port, smtp_user, smtp_from, smtp_from_name, is_active, updated_at
       FROM smtp_config WHERE company_id=$1 LIMIT 1`,
      [company_id]
    );
    return rows[0] ?? null;
  });

  // POST /api/email/smtp-config
  app.post('/smtp-config', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, role } = request.user;
    if (role !== 'admin' && role !== 'ceo') return reply.status(403).send({ error: 'Admin required' });

    const { smtp_host, smtp_port, smtp_user, smtp_password, smtp_from, smtp_from_name } = request.body;
    if (!smtp_host || !smtp_user || !smtp_password || !smtp_from) {
      return reply.status(400).send({ error: 'smtp_host, smtp_user, smtp_password, smtp_from required' });
    }

    await query(`DELETE FROM smtp_config WHERE company_id=$1`, [company_id]);
    const { rows } = await query(
      `INSERT INTO smtp_config (company_id, smtp_host, smtp_port, smtp_user, smtp_password, smtp_from, smtp_from_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, smtp_host, smtp_port, smtp_user, smtp_from, smtp_from_name, is_active`,
      [company_id, smtp_host, smtp_port ?? 587, smtp_user, smtp_password, smtp_from, smtp_from_name ?? 'Netaj ERP']
    );
    return rows[0];
  });

  // POST /api/email/test-smtp
  app.post('/test-smtp', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, role } = request.user;
    if (role !== 'admin' && role !== 'ceo') return reply.status(403).send({ error: 'Admin required' });

    const { rows } = await query(
      `SELECT * FROM smtp_config WHERE company_id=$1 AND is_active=true LIMIT 1`, [company_id]
    );
    if (!rows.length) return reply.status(400).send({ error: 'No SMTP config found' });
    const cfg = rows[0];

    try {
      const transporter = nodemailer.createTransport({
        host: cfg.smtp_host, port: cfg.smtp_port, secure: cfg.smtp_port === 465,
        auth: { user: cfg.smtp_user, pass: cfg.smtp_password },
      });
      await transporter.verify();
      return { ok: true, message: 'SMTP connection verified' };
    } catch (err) {
      return reply.status(400).send({ ok: false, message: err.message });
    }
  });

  // GET /api/email/queue — pending emails summary
  app.get('/queue-summary', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT status, COUNT(*) AS count FROM email_queue WHERE company_id=$1 GROUP BY status`,
      [company_id]
    );
    return rows;
  });
}
