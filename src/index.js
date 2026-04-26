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
import supplierContractRoutes  from './routes/procurement/supplier-contracts.js';
import txRegistryRoutes from './routes/finance/transaction-registry.js';
import dataSyncRoutes from './routes/data-sync.js';
import sharePointRoutes from './routes/sharepoint.js';
import contractsRoutes    from './routes/contracts.js';
import salesOrdersRoutes  from './routes/sales-orders.js';
import rfqScenarioRoutes  from './routes/rfq-scenarios.js';
import shipsgoRoutes      from './routes/logistics/shipsgo.js';
import invoicesRoutes     from './routes/invoices.js';
import hrRoutes           from './routes/hr.js';
import ceoKpiRoutes       from './routes/ceo-kpi.js';
import odooRoutes from './routes/odoo.js';
import smtpRoutes from './routes/email/smtp.js';
import aiDailyBriefRoutes from './routes/ai/daily-brief.js';
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

// ── Role-based access control ────────────────────────────────────
// Each guard verifies the JWT then checks the role claim.
// Individual route preHandlers also call app.authenticate — that is
// intentional redundancy (token is re-decoded from cache; no extra DB hit).

const ALL_ROLES = ['admin','ceo','finance','finance_user','factory_manager','logistics','logistics_manager','sales_user'];

const makeRoleGuard = (allowedRoles) => async (request, reply) => {
  try {
    await request.jwtVerify();
  } catch {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
  const role = request.user?.role;
  if (!allowedRoles.includes(role)) {
    return reply.status(403).send({ error: 'Forbidden — insufficient permissions' });
  }
};

// Role sets
const FINANCE_ROLES  = ['admin','ceo','finance','finance_user','factory_manager'];
const PROD_ROLES     = ['admin','ceo','factory_manager'];
const PROCURE_ROLES  = ['admin','ceo','factory_manager'];
const INVT_ROLES     = ['admin','ceo','factory_manager','logistics','logistics_manager'];
const LOGI_ROLES     = ['admin','ceo','logistics','logistics_manager','sales_user'];
const SALES_ROLES    = ['admin','ceo','logistics','logistics_manager','sales_user'];
const HR_ROLES       = ['admin','ceo','finance','finance_user','factory_manager'];
const APPROVALS_ROLES = ['admin','ceo'];
const ADMIN_ONLY     = ['admin'];

// ── Public routes (no auth required) ────────────────────────────
await app.register(healthRoutes,   { prefix: '/api' });
await app.register(authRoutes,     { prefix: '/api/auth' });
await app.register(authExtrasRoutes, { prefix: '/api/auth' });
await app.register(microsoftRoutes,  { prefix: '/api/auth' });

// ── General authenticated routes (all valid roles) ───────────────
// Settings, users, clients, invoices, contracts — used across roles
await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(ALL_ROLES));
  await scope.register(settingsRoutes);
  await scope.register(usersRoutes);
  await scope.register(clientsRoutes);
  await scope.register(invoicesRoutes);
  await scope.register(contractsRoutes);
}, { prefix: '/api' });

// ── Finance routes ───────────────────────────────────────────────
await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(FINANCE_ROLES));
  await scope.register(fundsRoutes);
  await scope.register(banksRoutes);
  await scope.register(cardsRoutes);
  await scope.register(categoriesRoutes);
  await scope.register(notificationsRoutes);
  await scope.register(supplierPaymentsRoutes);
  await scope.register(advancesRoutes);
  await scope.register(txRegistryRoutes);
}, { prefix: '/api/finance' });

await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(FINANCE_ROLES));
  await scope.register(cashflowRoutes);
}, { prefix: '/api/cashflow' });

// ── Production routes ────────────────────────────────────────────
await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(PROD_ROLES));
  await scope.register(ordersRoutes);
  await scope.register(batchesRoutes);
  await scope.register(dispatchRoutes);
  await scope.register(byproductRoutes);
  await scope.register(shippingOrdersRoutes);
  await scope.register(productionInventoryRoutes);
  await scope.register(shipmentsRoutes);
  await scope.register(fulfillmentRoutes);
  await scope.register(clientsRoutes);
}, { prefix: '/api/production' });

await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(PROD_ROLES));
  await scope.register(costingRoutes);
}, { prefix: '/api/costing' });

await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(PROD_ROLES));
  await scope.register(packagingRoutes);
}, { prefix: '/api/packaging' });

// ── Procurement routes ───────────────────────────────────────────
await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(PROCURE_ROLES));
  await scope.register(suppliersRoutes);
  await scope.register(purchasesRoutes);
  await scope.register(procurementExtrasRoutes);
  await scope.register(supplierContractRoutes);
}, { prefix: '/api/procurement' });

// ── Inventory routes ─────────────────────────────────────────────
await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(INVT_ROLES));
  await scope.register(inventoryRoutes);
}, { prefix: '/api/inventory' });

// ── Logistics / Sales routes ─────────────────────────────────────
await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(LOGI_ROLES));
  await scope.register(logisticsRoutes);
  await scope.register(shipsgoRoutes);
}, { prefix: '/api/logistics' });

await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(SALES_ROLES));
  await scope.register(salesOrdersRoutes);
}, { prefix: '/api/sales-orders' });

await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(SALES_ROLES));
  await scope.register(salesStatsRoutes);
  await scope.register(rfqScenarioRoutes);
}, { prefix: '/api/sales' });

// ── HR routes ────────────────────────────────────────────────────
await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(HR_ROLES));
  await scope.register(hrRoutes);
}, { prefix: '/api/hr' });

// ── Approvals + KPI (CEO & Admin) ───────────────────────────────
await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(APPROVALS_ROLES));
  await scope.register(approvalsRoutes);
}, { prefix: '/api/approvals' });

await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(APPROVALS_ROLES));
  await scope.register(kpiRoutes);
}, { prefix: '/api/kpi' });

await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(APPROVALS_ROLES));
  await scope.register(ceoKpiRoutes);
}, { prefix: '/api/dashboard' });

// ── Admin-only routes ────────────────────────────────────────────
await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(ADMIN_ONLY));
  await scope.register(adminRoutes);
}, { prefix: '/api/admin' });

await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(ADMIN_ONLY));
  await scope.register(dataSyncRoutes);
}, { prefix: '/api/data-sync' });

// ── SharePoint upload service (any authenticated user can post a file) ──
await app.register(async (scope) => {
  await scope.register(sharePointRoutes);
}, { prefix: '/api/sharepoint' });

await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(ADMIN_ONLY));
  await scope.register(emailQueueRoutes);
}, { prefix: '/api/email-queue' });

await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(ADMIN_ONLY));
  await scope.register(smtpRoutes);
}, { prefix: '/api/email' });

// ── Audit + Odoo (Admin + CEO) ───────────────────────────────────
await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(APPROVALS_ROLES));
  await scope.register(auditRoutes);
}, { prefix: '/api/audit' });

await app.register(async (scope) => {
  scope.addHook('preHandler', makeRoleGuard(APPROVALS_ROLES));
  await scope.register(odooRoutes);
}, { prefix: '/api/odoo' });

// ── AI (all authenticated roles can ask for a daily brief) ───────
// The route itself calls app.authenticate; no extra role guard needed.
// Mounted under /api so the frontend hits /api/ai/daily-brief.
await app.register(aiDailyBriefRoutes, { prefix: '/api' });

// ── 404 fallback ─────────────────────────────────────────────────
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
  next8am.setUTCHours(5, 0, 0, 0);
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
