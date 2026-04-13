/**
 * Daily Email Digest Cron
 * 1. Payments due in ≤3 days  → finance team
 * 2. Payments overdue          → finance team
 * 3. Documents expiring ≤30d   → HR admin
 */
import { query } from "../db.js";
import { queueEmail, emailTemplate } from "./email.js";
import { notifyPaymentDueSoon, notifyPaymentOverdue, notifyDocumentExpiring } from "./teamsNotify.js";

async function getRoleEmails(company_id, roles) {
  const { rows } = await query(
    `SELECT DISTINCT u.email FROM users u JOIN user_roles ur ON ur.user_id = u.id
     WHERE u.company_id = $1 AND ur.role = ANY($2) AND u.is_active = true`,
    [company_id, roles]
  );
  return rows.map(r => r.email);
}

export async function getFinanceEmails(company_id) {
  const e = await getRoleEmails(company_id, ["admin", "finance"]);
  return e.length ? e : ["finance@netaj.sa"];
}

export async function getHREmails(company_id) {
  const e = await getRoleEmails(company_id, ["admin", "hr"]);
  return e.length ? e : ["hr@netaj.sa"];
}

const fmtDate  = d => d ? new Date(d).toLocaleDateString("en-GB") : "N/A";
const fmtAmt   = (v, c) => v ? `${Number(v).toLocaleString()} ${c ?? "SAR"}` : "—";
const daysUntil = d => {
  if (!d) return null;
  return Math.ceil((new Date(d) - new Date()) / 86400000);
};
const badge = days => {
  if (days === null) return "";
  if (days < 0)  return `<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:10px;font-size:11px">EXPIRED</span>`;
  if (days <= 7) return `<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:10px;font-size:11px">${days}d left</span>`;
  return `<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:10px;font-size:11px">${days}d left</span>`;
};

export async function sendPaymentDueDigest(company_id) {
  const in3d = new Date(Date.now() + 3 * 86400000).toISOString();

  const { rows: dueSoon } = await query(
    `SELECT so.order_number, c.name AS client_name, so.total_value, so.currency, so.payment_due_date
     FROM sales_orders so LEFT JOIN clients c ON c.id = so.client_id
     WHERE so.company_id=$1 AND so.payment_due_date >= NOW() AND so.payment_due_date <= $2
       AND COALESCE(so.payment_status, '') != 'paid' ORDER BY so.payment_due_date`,
    [company_id, in3d]
  );

  const { rows: overdue } = await query(
    `SELECT so.order_number, c.name AS client_name, so.total_value, so.currency, so.payment_due_date
     FROM sales_orders so LEFT JOIN clients c ON c.id = so.client_id
     WHERE so.company_id=$1 AND so.payment_due_date < NOW()
       AND COALESCE(so.payment_status, '') != 'paid' ORDER BY so.payment_due_date`,
    [company_id]
  );

  if (!dueSoon.length && !overdue.length) return;

  // Teams notifications — one per payment (fire-and-forget)
  for (const p of overdue)  { try { await notifyPaymentOverdue(p);  } catch (_e) {} }
  for (const p of dueSoon)  { try { await notifyPaymentDueSoon(p);  } catch (_e) {} }

  let body = "";
  if (overdue.length) {
    body += `<h3 style="color:#991b1b">⚠️ Overdue Payments (${overdue.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
    <tr style="background:#fee2e2"><th style="padding:6px;text-align:left">PO#</th><th style="text-align:left">Client</th><th style="text-align:left">Amount</th><th style="text-align:left">Due Date</th></tr>`;
    for (const r of overdue)
      body += `<tr><td style="padding:5px;border-bottom:1px solid #fecaca">${r.order_number}</td><td style="padding:5px;border-bottom:1px solid #fecaca">${r.client_name ?? "—"}</td><td style="padding:5px;border-bottom:1px solid #fecaca">${fmtAmt(r.total_value, r.currency)}</td><td style="padding:5px;border-bottom:1px solid #fecaca;color:#991b1b"><strong>${fmtDate(r.payment_due_date)}</strong></td></tr>`;
    body += "</table><br>";
  }
  if (dueSoon.length) {
    body += `<h3 style="color:#92400e">🕐 Due in 3 Days (${dueSoon.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
    <tr style="background:#fef3c7"><th style="padding:6px;text-align:left">PO#</th><th style="text-align:left">Client</th><th style="text-align:left">Amount</th><th style="text-align:left">Due Date</th></tr>`;
    for (const r of dueSoon)
      body += `<tr><td style="padding:5px;border-bottom:1px solid #fde68a">${r.order_number}</td><td style="padding:5px;border-bottom:1px solid #fde68a">${r.client_name ?? "—"}</td><td style="padding:5px;border-bottom:1px solid #fde68a">${fmtAmt(r.total_value, r.currency)}</td><td style="padding:5px;border-bottom:1px solid #fde68a;color:#92400e">${fmtDate(r.payment_due_date)}</td></tr>`;
    body += "</table>";
  }

  await queueEmail({
    company_id,
    to: await getFinanceEmails(company_id),
    subject: `[Natej ERP] Daily Payment Summary — ${overdue.length} Overdue, ${dueSoon.length} Due Soon`,
    body_html: emailTemplate("Daily Payment Summary", body),
    transaction_type: "payment_digest",
    priority: "high",
  });
}

export async function sendDocumentExpiryDigest(company_id) {
  const { rows } = await query(
    `SELECT full_name, job_title, department, iqama_expiry, passport_expiry
     FROM employees WHERE company_id=$1 AND status = 'active'
       AND ((iqama_expiry IS NOT NULL AND iqama_expiry <= NOW() + INTERVAL '30 days')
         OR (passport_expiry IS NOT NULL AND passport_expiry <= NOW() + INTERVAL '30 days'))
     ORDER BY LEAST(COALESCE(iqama_expiry,'9999-12-31'::date), COALESCE(passport_expiry,'9999-12-31'::date))`,
    [company_id]
  );
  if (!rows.length) return;

  // Teams notifications for each expiring document
  for (const e of rows) {
    const id = daysUntil(e.iqama_expiry);
    const pd = daysUntil(e.passport_expiry);
    if (id !== null && id <= 30) {
      try { await notifyDocumentExpiring({ full_name: e.full_name, document_type: "Iqama", expiry_date: e.iqama_expiry, days_left: id }); } catch (_e) {}
    }
    if (pd !== null && pd <= 30) {
      try { await notifyDocumentExpiring({ full_name: e.full_name, document_type: "Passport", expiry_date: e.passport_expiry, days_left: pd }); } catch (_e) {}
    }
  }

  let body = `<p>Employees with documents expiring within 30 days:</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
  <tr style="background:#f8fafc"><th style="padding:6px;text-align:left">Employee</th><th style="text-align:left">Department</th><th style="text-align:left">Iqama</th><th style="text-align:left">Passport</th></tr>`;
  for (const e of rows) {
    const id = daysUntil(e.iqama_expiry);
    const pd = daysUntil(e.passport_expiry);
    body += `<tr><td style="padding:5px;border-bottom:1px solid #e5e7eb"><strong>${e.full_name}</strong></td>
    <td style="padding:5px;border-bottom:1px solid #e5e7eb">${e.department ?? "—"}</td>
    <td style="padding:5px;border-bottom:1px solid #e5e7eb">${id !== null && id <= 30 ? fmtDate(e.iqama_expiry) + " " + badge(id) : "—"}</td>
    <td style="padding:5px;border-bottom:1px solid #e5e7eb">${pd !== null && pd <= 30 ? fmtDate(e.passport_expiry) + " " + badge(pd) : "—"}</td></tr>`;
  }
  body += "</table>";

  await queueEmail({
    company_id,
    to: await getHREmails(company_id),
    subject: `[Natej ERP] Document Expiry Alert — ${rows.length} Employee(s)`,
    body_html: emailTemplate("Document Expiry Alert", body),
    transaction_type: "document_expiry_digest",
    priority: "high",
  });
}

export async function runDailyDigest() {
  // Use all distinct companies that have active users — no longer tied to smtp_config
  const { rows } = await query(
    `SELECT DISTINCT company_id FROM users WHERE is_active = true`
  );
  for (const { company_id } of rows) {
    try { await sendPaymentDueDigest(company_id); }    catch(e) { console.error("payment digest:", e.message); }
    try { await sendDocumentExpiryDigest(company_id); } catch(e) { console.error("doc expiry:", e.message); }
  }
}
