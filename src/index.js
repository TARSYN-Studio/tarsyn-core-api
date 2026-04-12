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

// ── 404 fallback ─────────────────────────────────────────────────
app.setNotFoundHandler((_request, reply) => {
  reply.status(404).send({ error: 'Route not found' });
});

// ── Start ────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT ?? '3000', 10);

try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
