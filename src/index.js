import 'dotenv/config';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import healthRoutes      from './routes/health.js';
import authRoutes        from './routes/auth.js';
import ordersRoutes      from './routes/production/orders.js';
import batchesRoutes     from './routes/production/batches.js';
import inventoryRoutes   from './routes/inventory/items.js';
import suppliersRoutes   from './routes/procurement/suppliers.js';
import purchasesRoutes   from './routes/procurement/purchases.js';
import fundsRoutes             from './routes/finance/funds.js';
import banksRoutes             from './routes/finance/banks.js';
import cardsRoutes             from './routes/finance/cards.js';
import categoriesRoutes        from './routes/finance/categories.js';
import notificationsRoutes     from './routes/finance/notifications.js';
import supplierPaymentsRoutes  from './routes/finance/supplier-payments.js';
import shipmentsRoutes   from './routes/production/shipments.js';
import fulfillmentRoutes from './routes/production/fulfillment.js';
import microsoftRoutes   from './routes/auth/microsoft.js';
import settingsRoutes    from './routes/settings.js';
import usersRoutes     from './routes/users.js';
import kpiRoutes       from './routes/kpi.js';
import clientsRoutes   from './routes/production/clients.js';

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
await app.register(healthRoutes,    { prefix: '/api' });
await app.register(authRoutes,      { prefix: '/api/auth' });
await app.register(ordersRoutes,    { prefix: '/api/production' });
await app.register(batchesRoutes,   { prefix: '/api/production' });
await app.register(inventoryRoutes, { prefix: '/api/inventory' });
await app.register(suppliersRoutes,   { prefix: '/api/procurement' });
await app.register(purchasesRoutes,   { prefix: '/api/procurement' });
await app.register(fundsRoutes,            { prefix: '/api/finance' });
await app.register(banksRoutes,            { prefix: '/api/finance' });
await app.register(cardsRoutes,            { prefix: '/api/finance' });
await app.register(categoriesRoutes,       { prefix: '/api/finance' });
await app.register(notificationsRoutes,    { prefix: '/api/finance' });
await app.register(supplierPaymentsRoutes, { prefix: '/api/finance' });
await app.register(shipmentsRoutes,   { prefix: '/api/production' });
await app.register(fulfillmentRoutes, { prefix: '/api/production' });
await app.register(microsoftRoutes, { prefix: '/api/auth' });
await app.register(settingsRoutes,  { prefix: '/api' });
await app.register(usersRoutes,     { prefix: '/api' });
await app.register(kpiRoutes,       { prefix: '/api/kpi' });
await app.register(clientsRoutes,   { prefix: '/api/production' });

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
