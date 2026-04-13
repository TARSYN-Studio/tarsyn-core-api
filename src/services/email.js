import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import { query } from '../db.js';

const SENDER      = process.env.MAIL_SENDER      ?? 'notifications@netaj.sa';
const SENDER_NAME = process.env.MAIL_SENDER_NAME ?? 'Natej ERP';

function createGraphClient() {
  const credential = new ClientSecretCredential(
    process.env.AZURE_MAIL_TENANT_ID,
    process.env.AZURE_MAIL_CLIENT_ID,
    process.env.AZURE_MAIL_CLIENT_SECRET,
  );
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default'],
  });
  return Client.initWithMiddleware({ authProvider });
}

// ── Public helpers ───────────────────────────────────────────────

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
  const graphClient = createGraphClient();

  // Claim up to 10 pending emails atomically
  const { rows: emails } = await query(
    `UPDATE email_queue SET status='sending', updated_at=now()
     WHERE id IN (
       SELECT id FROM email_queue
       WHERE status = 'pending'
       ORDER BY priority DESC, created_at ASC
       LIMIT 10
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  );

  for (const email of emails) {
    try {
      const recipients = Array.isArray(email.recipients)
        ? email.recipients
        : JSON.parse(email.recipients);

      const toRecipients = recipients.map(r => ({
        emailAddress: typeof r === 'string'
          ? { address: r }
          : { address: r.email, ...(r.name ? { name: r.name } : {}) },
      }));

      await graphClient.api(`/users/${SENDER}/sendMail`).post({
        message: {
          subject: email.subject,
          body: { contentType: 'HTML', content: email.body_html },
          toRecipients,
          from: { emailAddress: { address: SENDER, name: SENDER_NAME } },
        },
        saveToSentItems: false,
      });

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
<div class="hdr"><h1>Natej ERP — ${title}</h1></div>
<div class="body">${body}</div>
<div class="footer">Natej ERP &nbsp;·&nbsp; netaj.co &nbsp;·&nbsp; Automated notification</div>
</div></body></html>`;
}
