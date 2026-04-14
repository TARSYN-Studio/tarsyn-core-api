/**
 * teamsNotify.js
 * Sends messages to Microsoft Teams via Incoming Webhook.
 *
 * Setup (one-time, 2 minutes):
 *   Teams channel → "..." menu → Connectors → Incoming Webhook → Create
 *   Copy the webhook URL → add to .env as TEAMS_WEBHOOK_URL
 *
 * The Graph API approach (client_credentials) requires ChannelMessage.Send
 * or Teamwork.Migrate.All — both need Global Admin consent.
 * Incoming webhooks bypass this entirely.
 */

const WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL;

// ── Core send ─────────────────────────────────────────────────────────────────
async function sendMessage(text, color = "#0078D4") {
  if (!WEBHOOK_URL) {
    // Webhook not configured yet — log instead of silently swallowing
    console.log("[Teams] TEAMS_WEBHOOK_URL not set. Message:", text.replace(/<[^>]+>/g, ""));
    return;
  }
  try {
    // Adaptive card for Teams (incoming webhook format)
    const payload = {
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
            type: "AdaptiveCard",
            version: "1.3",
            body: [
              {
                type: "TextBlock",
                text: text.replace(/<br>/g, "\n").replace(/<[^>]+>/g, ""),
                wrap: true,
                color: color === "#991b1b" ? "Attention" : "Default",
              },
            ],
            msteams: { width: "Full" },
          },
        },
      ],
    };
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("[Teams] Send failed:", res.status, err.slice(0, 200));
    }
  } catch (e) {
    // Never crash the main API operation
    console.error("[Teams] Notify error:", e.message);
  }
}

const fmtDate = d => d ? new Date(d).toLocaleDateString("en-GB") : "N/A";
const fmtAmt  = (v, c) => v ? `${Number(v).toLocaleString()} ${c ?? "SAR"}` : "—";

// ── 1. Payment due in 3 days ──────────────────────────────────────────────────
export async function notifyPaymentDueSoon(payment) {
  const days = payment.payment_due_date
    ? Math.ceil((new Date(payment.payment_due_date) - new Date()) / 86_400_000)
    : "?";
  await sendMessage(
    `⏰ Payment Due Soon — ${days} day(s)\n` +
    `Order: ${payment.order_number ?? "—"}  |  Client: ${payment.client_name ?? "—"}\n` +
    `Amount: ${fmtAmt(payment.total_value, payment.currency)}  |  Due: ${fmtDate(payment.payment_due_date)}`,
    "#92400e"
  );
}

// ── 2. Payment overdue ────────────────────────────────────────────────────────
export async function notifyPaymentOverdue(payment) {
  const overdueDays = payment.payment_due_date
    ? Math.ceil((new Date() - new Date(payment.payment_due_date)) / 86_400_000)
    : "?";
  await sendMessage(
    `🚨 Payment OVERDUE — ${overdueDays} day(s) past due\n` +
    `Order: ${payment.order_number ?? "—"}  |  Client: ${payment.client_name ?? "—"}\n` +
    `Amount: ${fmtAmt(payment.total_value, payment.currency)}  |  Was due: ${fmtDate(payment.payment_due_date)}`,
    "#991b1b"
  );
}

// ── 3. Document expiring ──────────────────────────────────────────────────────
export async function notifyDocumentExpiring(doc) {
  // doc: { full_name, document_type ('Iqama'|'Passport'), expiry_date, days_left }
  const urgency = (doc.days_left ?? 99) <= 7 ? "🔴" : "🟡";
  await sendMessage(
    `${urgency} Document Expiring — ${doc.document_type}\n` +
    `Employee: ${doc.full_name}  |  Expires: ${fmtDate(doc.expiry_date)}  |  Days left: ${doc.days_left ?? "?"}`,
    "#92400e"
  );
}

// ── 4. Copper/byproduct sale decision ─────────────────────────────────────────
export async function notifyCopperSaleDecision(sale, approved) {
  const icon   = approved ? "✅" : "❌";
  const action = approved ? "APPROVED" : "REJECTED";
  await sendMessage(
    `${icon} Copper Sale ${action}\n` +
    `Buyer: ${sale.buyer_name ?? "—"}  |  Qty: ${sale.quantity_mt ?? "—"} MT\n` +
    `Amount: ${fmtAmt(sale.total_amount, sale.currency)}  |  Type: ${sale.item_type ?? "copper"}`,
    approved ? "#166534" : "#991b1b"
  );
}

// ── 5. Payroll approved ───────────────────────────────────────────────────────
export async function notifyPayrollApproved(payroll) {
  await sendMessage(
    `✅ Payroll Approved\n` +
    `Period: ${payroll.month ?? "?"}/${payroll.year ?? "?"}  |  Employees: ${payroll.item_count ?? "—"}\n` +
    `Total Net: ${fmtAmt(payroll.total_net, "SAR")}`,
    "#166534"
  );
}

// ── 6. Supplier/Vendor Payment Created ───────────────────────────────────────
export async function notifySupplierPaymentCreated({ supplierName, amount, reference, notes, currency = 'SAR' }) {
  await sendMessage(
    `💳 Vendor Direct Payment Submitted
` +
    `Supplier: ${supplierName ?? "—"}  |  Amount: ${fmtAmt(amount, currency)}
` +
    `Reference: ${reference ?? "—"}  |  Notes: ${notes ?? "—"}`,
    "#0078D4"
  );
}
