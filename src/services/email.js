import nodemailer from 'nodemailer';
import { query } from '../db.js';

async function getSmtpConfig(company_id) {
  const { rows } = await query(
    `SELECT * FROM smtp_config WHERE company_id = $1 AND is_active = true LIMIT 1`,
    [company_id]
  );
  return rows[0] ?? null;
}

function createTransporter(cfg) {
  return nodemailer.createTransport({
    host:   cfg.smtp_host,
    port:   cfg.smtp_port,
    secure: cfg.smtp_port === 465,
    auth:   { user: cfg.smtp_user, pass: cfg.smtp_password },
  });
}

export async function queueEmail({ company_id, to, subject, body_html, transaction_id, transaction_type, priority = 'normal' }) {
  const recipients = Array.isArray(to) ? to : [typeof to === 'string' ? { email: to } : to];
  await query(
    `INSERT INTO email_queue (company_id, transaction_id, transaction_type, recipients, subject, body_html, priority, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')`,
    [company_id, transaction_id ?? null, transaction_type ?? null,
     JSON.stringify(recipients), subject, body_html, priority]
  );
}

export async function processEmailQueue() {
  const { rows: companies } = await query(
    `SELECT DISTINCT company_id FROM email_queue WHERE status = 'pending' LIMIT 20`
  );

  for (const { company_id } of companies) {
    const cfg = await getSmtpConfig(company_id);
    if (!cfg) continue;

    const transporter = createTransporter(cfg);
    const from = `"${cfg.smtp_from_name}" <${cfg.smtp_from}>`;

    const { rows: emails } = await query(
      `UPDATE email_queue SET status='sending', updated_at=now()
       WHERE id IN (
         SELECT id FROM email_queue
         WHERE company_id = $1 AND status = 'pending'
         ORDER BY priority DESC, created_at ASC
         LIMIT 10
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [company_id]
    );

    for (const email of emails) {
      try {
        const recipients = Array.isArray(email.recipients)
          ? email.recipients
          : JSON.parse(email.recipients);

        const toList = recipients.map(r =>
          typeof r === 'string' ? r : r.name ? `"${r.name}" <${r.email}>` : r.email
        ).join(', ');

        await transporter.sendMail({ from, to: toList, subject: email.subject, html: email.body_html });

        await query(
          `UPDATE email_queue SET status='sent', sent_at=now(), updated_at=now(), error_message=null WHERE id=$1`,
          [email.id]
        );
      } catch (err) {
        await query(
          `UPDATE email_queue SET status='failed', error_message=$1, updated_at=now() WHERE id=$2`,
          [err.message, email.id]
        );
      }
    }
  }
}

export function emailTemplate(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:0}
.wrap{max-width:600px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.hdr{background:#0f172a;padding:20px 32px}.hdr h1{color:#f1f5f9;font-size:18px;margin:0}
.body{padding:28px 32px;color:#374151;line-height:1.6}
.footer{background:#f8fafc;padding:16px 32px;font-size:12px;color:#9ca3af;text-align:center}
.btn{display:inline-block;background:#2563eb;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:bold;margin-top:16px}
.green{background:#dcfce7;color:#166534;display:inline-block;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:bold}
.red{background:#fee2e2;color:#991b1b;display:inline-block;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:bold}
.amber{background:#fef3c7;color:#92400e;display:inline-block;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:bold}
</style></head><body>
<div class="wrap">
<div class="hdr"><h1>Netaj ERP — ${title}</h1></div>
<div class="body">${body}</div>
<div class="footer">Netaj ERP &nbsp;·&nbsp; netaj.co &nbsp;·&nbsp; Automated notification</div>
</div></body></html>`;
}
