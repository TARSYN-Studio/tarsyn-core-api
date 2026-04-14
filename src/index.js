import 'dotenv/config';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import healthRoutes           from './routes/health.js';
import authRoutes             from './routes/auth.js';
import authExtrasRoutes       from './routes/auth/extras.js';
import ordersRoutes           from './routes/production/orders.js';
import batchesRoutes          from './routes/production/batches.js';
import inventoryRoutes        from './routes/inventory/items.js';
import suppliersRoutes        from './routes/procurement/suppliers.js';
import purchasesRoutes        from './routes/procurement/purchases.js';
import fundsRoutes            from './routes/finance/funds.js';
import banksRoutes            from './routes/finance/banks.js';
import cardsRoutes            from './routes/finance/cards.js';
import categoriesRoutes       from './routes/finance/categories.js';
import notificationsRoutes    from './routes/finance/notifications.js';
import supplierPaymentsRoutes from './routes/finance/supplier-payments.js';
import advancesRoutes         from './routes/finance/advances.js';
import shipmentsRoutes        from './routes/production/shipments.js';
import fulfillmentRoutes      from './routes/production/fulfillment.js';
import microsoftRoutes        from './routes/auth/microsoft.js';
import settingsRoutes         from './routes/settings.js';
import usersRoutes            from './routes/users.js';
import kpiRoutes              from './routes/kpi.js';
import logisticsRoutes        from './routes/logistics.js';
import costingRoutes          from './routes/costing.js';
import clientsRoutes          from './routes/production/clients.js';
import cashflowRoutes         from './routes/cashflow.js';
import adminRoutes            from './routes/admin.js';
// ── New routes ───────────────────────────────────────────────────
import approvalsRoutes        from './routes/approvals.js';
import salesStatsRoutes       from './routes/sales-stats.js';
import auditRoutes            from './routes/audit/logs.js';
import emailQueueRoutes       from './routes/email-queue/index.js';
import packagingRoutes        from './routes/packaging/index.js';
import byproductRoutes        from './routes/production/byproducts.js';
import shippingOrdersRoutes   from './routes/production/shipping-orders.js';
import dispatchRoutes         from './routes/production/dispatch.js';
import productionInventoryRoutes from './routes/production/inventory-extras.js';
import procurementExtrasRoutes from './routes/procurement/extras.js';
import txRegistryRoutes from './routes/finance/transaction-registry.js';
import dataSyncRoutes from './routes/data-sync.js';
import contractsRoutes    from './routes/contracts.js';
import salesOrdersRoutes  from './routes/sales-orders.js';
import shipsgoRoutes      from './routes/logistics/shipsgo.js';
import invoicesRoutes     from './routes/invoices.js';
import hrRoutes           from './routes/hr.js';
import ceoKpiRoutes       from './routes/ceo-kpi.js';
import odooRoutes from './routes/odoo.js';
import smtpRoutes from './routes/email/smtp.js';
import { processEmailQueue } from './services/email.js';
import { runDailyDigest } from './services/notifications-cron.js';

const app = Fastify({ logger: true });

// ── JWT ──────────────────────────────────────────────────────────
await app.register(fastifyJwt, {
  secret: process.env.JWT_SECRET,
});

app.decorate('authenticate', async (request, reply) => {
  try {
    await request.jwtVerify();
  } catch {
    return reply.status(401).send({ error: 'Unauthorized — valid JWT required' });
  }
});

// ── Routes ───────────────────────────────────────────────────────
await app.register(healthRoutes,              { prefix: '/api' });
await app.register(authRoutes,                { prefix: '/api/auth' });
await app.register(authExtrasRoutes,          { prefix: '/api/auth' });
await app.register(microsoftRoutes,           { prefix: '/api/auth' });
await app.register(ordersRoutes,              { prefix: '/api/production' });
await app.register(batchesRoutes,             { prefix: '/api/production' });
await app.register(dispatchRoutes,            { prefix: '/api/production' });
await app.register(byproductRoutes,           { prefix: '/api/production' });
await app.register(shippingOrdersRoutes,      { prefix: '/api/production' });
await app.register(productionInventoryRoutes, { prefix: '/api/production' });
await app.register(inventoryRoutes,           { prefix: '/api/inventory' });
await app.register(shipmentsRoutes,           { prefix: '/api/production' });
await app.register(fulfillmentRoutes,         { prefix: '/api/production' });
await app.register(clientsRoutes,             { prefix: '/api/production' });
await app.register(clientsRoutes,             { prefix: '/api' });
await app.register(suppliersRoutes,           { prefix: '/api/procurement' });
await app.register(purchasesRoutes,           { prefix: '/api/procurement' });
await app.register(fundsRoutes,               { prefix: '/api/finance' });
await app.register(banksRoutes,               { prefix: '/api/finance' });
await app.register(cardsRoutes,               { prefix: '/api/finance' });
await app.register(categoriesRoutes,          { prefix: '/api/finance' });
await app.register(notificationsRoutes,       { prefix: '/api/finance' });
await app.register(supplierPaymentsRoutes,    { prefix: '/api/finance' });
await app.register(advancesRoutes,            { prefix: '/api/finance' });
await app.register(settingsRoutes,            { prefix: '/api' });
await app.register(usersRoutes,               { prefix: '/api' });
await app.register(kpiRoutes,                 { prefix: '/api/kpi' });
await app.register(logisticsRoutes,           { prefix: '/api/logistics' });
await app.register(costingRoutes,             { prefix: '/api/costing' });
await app.register(cashflowRoutes,            { prefix: '/api/cashflow' });
await app.register(adminRoutes,               { prefix: '/api/admin' });
await app.register(approvalsRoutes,           { prefix: '/api/approvals' });
await app.register(salesStatsRoutes,          { prefix: '/api/sales' });
await app.register(auditRoutes,               { prefix: '/api/audit' });
await app.register(emailQueueRoutes,          { prefix: '/api/email-queue' });
await app.register(packagingRoutes,           { prefix: '/api/packaging' });
await app.register(procurementExtrasRoutes,  { prefix: '/api/procurement' });
await app.register(txRegistryRoutes,         { prefix: '/api/finance' });
await app.register(dataSyncRoutes,           { prefix: '/api/data-sync' });
await app.register(contractsRoutes,          { prefix: '/api' });
await app.register(salesOrdersRoutes,        { prefix: '/api/sales-orders' });
await app.register(shipsgoRoutes,            { prefix: '/api/logistics' });
await app.register(invoicesRoutes,           { prefix: '/api' });
await app.register(hrRoutes,              { prefix: '/api/hr' });
await app.register(ceoKpiRoutes,         { prefix: '/api/dashboard' });

// ── 404 fallback ─────────────────────────────────────────────────
await app.register(odooRoutes, { prefix: '/api/odoo' });
await app.register(smtpRoutes,  { prefix: '/api/email' });

app.setNotFoundHandler((_request, reply) => {
  reply.status(404).send({ error: 'Route not found' });
});

// ── Start ────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT ?? '3000', 10);

try {
  await app.listen({ port, host: '0.0.0.0' });


// Daily digest cron — fires at 08:00 server time (UTC+3 = 05:00 UTC)
function scheduleDailyDigest() {
  const now = new Date();
  const next8am = new Date(now);
  next8am.setUTCHours(5, 0, 0, 0); // 08:00 Saudi time (UTC+3)
  if (next8am <= now) next8am.setUTCDate(next8am.getUTCDate() + 1);
  const msUntil = next8am - now;
  setTimeout(async () => {
    try { await runDailyDigest(); } catch(e) { console.error("Daily digest error:", e.message); }
    setInterval(async () => {
      try { await runDailyDigest(); } catch(e) { console.error("Daily digest error:", e.message); }
    }, 24 * 60 * 60 * 1000);
  }, msUntil);
  console.log(`Daily digest scheduled — next run in ${Math.round(msUntil/60000)} minutes`);
}
scheduleDailyDigest();

// Email queue worker — runs every 2 minutes
setInterval(async () => {
  try { await processEmailQueue(); } catch (_e) {}
}, 2 * 60 * 1000);

} catch (err) {
  app.log.error(err);
  process.exit(1);
}
