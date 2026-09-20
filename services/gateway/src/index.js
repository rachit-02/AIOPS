// API gateway: the only backend entry point for the browser.
// Responsibilities: (1) allow-list what is publicly reachable, (2) verify JWTs,
// (3) route. Business logic stays in the services - the gateway stays thin.
import jwt from 'jsonwebtoken';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createService } from '../../_shared/index.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET is required');

const URLS = {
  auth: process.env.AUTH_SERVICE_URL || 'http://auth:3000',
  product: process.env.PRODUCT_SERVICE_URL || 'http://product:3000',
  order: process.env.ORDER_SERVICE_URL || 'http://order:3000',
  orders: process.env.ORDERS_SERVICE_URL || 'http://orders:3000',
  user: process.env.USER_SERVICE_URL || 'http://user:3000',
};

// parseBody:false - a proxy must stream the raw request body to the upstream.
const { app, start, log } = createService({ name: 'gateway', parseBody: false });

// SECURITY: downstream services trust x-user-id. Strip any client-supplied
// value on EVERY request so identity can only come from a verified JWT below.
app.use((req, res, next) => {
  delete req.headers['x-user-id'];
  next();
});

function requireAuth(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  try {
    if (scheme !== 'Bearer' || !token) throw new Error('missing bearer token');
    req.headers['x-user-id'] = jwt.verify(token, JWT_SECRET).sub;
    next();
  } catch (err) {
    res.locals.error = `auth_failed: ${err.message}`;
    res.status(401).json({ error: 'unauthorized' });
  }
}

// One proxy per upstream. Failure to reach the upstream becomes a 502 with a
// logged reason - "gateway can't reach order service" is a classic incident.
const proxyTo = (target) =>
  createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: { '^/api': '' }, // /api/orders -> /orders on the service
    proxyTimeout: 5000,
    on: {
      error: (err, req, res) => {
        log.error({ request_id: req.id, upstream: target, err: err.message }, 'upstream_error');
        if (res.writeHead && !res.headersSent) {
          res.locals && (res.locals.error = `upstream_error: ${err.message}`);
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad_gateway', upstream: target }));
        }
      },
    },
  });

const auth = proxyTo(URLS.auth);
const product = proxyTo(URLS.product);
const order = proxyTo(URLS.order);
const orders = proxyTo(URLS.orders);
const user = proxyTo(URLS.user);

// ---- Explicit allow-list ---------------------------------------------------
// WHY not a catch-all `app.use('/api/users', proxy)`: services have INTERNAL
// endpoints (POST /users, POST /products/reserve, ...). Listing public routes
// one by one makes them unreachable from outside by construction.
app.post('/api/auth/register', auth);
app.post('/api/auth/login', auth);

app.get('/api/products', product);
app.get('/api/products/:id', product);

// Public: the storefront asks the ORDER service which promo codes exist, rather
// than hardcoding a list that could drift from the server's. On its own path,
// not under /api/orders, which is routed to the read service.
app.get('/api/promo-codes', order);

app.get('/api/users/me', requireAuth, user);

// CQRS split at the edge: reads -> Orders, writes -> Order.
app.get('/api/orders', requireAuth, orders);
app.get('/api/orders/:id', requireAuth, orders);
app.post('/api/orders', requireAuth, order);
app.patch('/api/orders/:id/status', requireAuth, order);

start();
