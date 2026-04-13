import { query } from '../../db.js';
import { queueEmail, emailTemplate } from '../../services/email.js';

export default async function emailConfigRoutes(app) {

  // POST /api/email/send-test — send a real test email via Graph API
  app.post('/send-test', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id, role } = request.user;
    if (role !== 'admin' && role !== 'ceo') return reply.status(403).send({ error: 'Admin required' });

    const { to } = request.body;
    if (!to) return reply.status(400).send({ error: 'to (email address) is required' });

    await queueEmail({
      company_id,
      to,
      subject: '[Natej ERP] Test Email — Microsoft Graph',
      body_html: emailTemplate('Email Test', `
        <p>This is a test email sent from <strong>Natej ERP</strong> via Microsoft Graph API.</p>
        <p style="color:#16a34a">&#x2705; If you received this, email notifications are working correctly.</p>
        <p style="color:#6b7280;font-size:13px">Sender: ${process.env.MAIL_SENDER ?? 'notifications@netaj.sa'}<br>Time: ${new Date().toISOString()}</p>
      `),
      transaction_type: 'test',
      priority: 'high',
    });

    return { ok: true, message: `Test email queued for ${to}` };
  });

  // GET /api/email/queue-summary — pending email status
  app.get('/queue-summary', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = request.user;
    const { rows } = await query(
      `SELECT status, COUNT(*) AS count FROM email_queue WHERE company_id=$1 GROUP BY status`,
      [company_id]
    );
    return rows;
  });
}
