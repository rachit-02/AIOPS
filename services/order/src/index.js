// Order service: the WRITE path (create / update status).
// Reads (history, listing) are served by the separate Orders service.
import { createService, createPool, callService, asyncHandler as ah } from '../../_shared/index.js';
import { applyPromo, authorizePayment, fxRate, isSupportedCurrency, promoCodeNames } from './commerce.js';

const PRODUCT_URL = process.env.PRODUCT_SERVICE_URL || 'http://product:3000';
const pool = createPool();
const { app, start, log } = createService({ name: 'order', pool });

// Allowed status transitions. Encoding the state machine here means the API
// cannot express nonsense like delivered -> pending.
const TRANSITIONS = {
  pending: ['paid', 'cancelled'],
  paid: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

const userIdOf = (req) => Number(req.headers['x-user-id']) || null;

/**
 * Compensating action for every path that aborts AFTER stock was reserved.
 *
 * There are now three such paths (unsupported currency, payment declined,
 * database failure). Each one that forgot to call this would leak stock
 * permanently - the items would be unavailable to everyone with no order to
 * show for it - so it lives in one place rather than being repeated.
 */
async function releaseStock(items, requestId) {
  await callService(PRODUCT_URL, '/products/release', {
    method: 'POST', body: { items }, requestId,
  }).catch((e) => log.error({ request_id: requestId, err: e.message }, 'stock_release_failed'));
}

// =============================================================================
// !!! SEEDED BUG - DELIBERATE, DO NOT "FIX" !!!
// Toggle: env SEED_BUG_NULL_SHIPPING=true  (docker-compose: default false)
//
// What it simulates: a "guest checkout" refactor that dropped the shipping-
// address validation. With the flag ON, POST /orders WITHOUT a shippingAddress
// crashes with an unhandled TypeError ("Cannot read properties of undefined
// (reading 'line1')") -> HTTP 500 for those requests only. Orders that DO
// include an address still succeed, so the failure is partial and shows up as
// an error-rate spike on the Order service, not a full outage.
//
// Why it exists: it is the realistic incident Kira diagnoses in Phase 6.
// The evidence trail she should correlate:
//   metrics : http_requests_total{job="order",route="/orders",status="500"} rising
//   logs    : level="error" "unhandled_error" with the TypeError stack pointing
//             at buildShipTo() in services/order/src/index.js
//   health  : pods stay Ready (the process doesn't crash) - which is the point:
//             health alone says "fine", metrics + logs reveal the problem.
// Human fix (Kira only diagnoses): validate the address (flag OFF path) or
// unset the env var.
// =============================================================================
const SEED_BUG_NULL_SHIPPING = process.env.SEED_BUG_NULL_SHIPPING === 'true';

// Correct behaviour: returns a clean address, or null when invalid.
function validateShipTo(a) {
  if (!a || typeof a !== 'object') return null;
  const { line1, city, postcode } = a;
  if ([line1, city, postcode].some((v) => typeof v !== 'string' || !v.trim())) return null;
  return { line1: line1.trim(), city: city.trim(), postcode: postcode.trim().toUpperCase() };
}

// BUGGY behaviour (only used when the flag is on): assumes the address exists.
function buildShipTo(a) {
  return { line1: a.line1.trim(), city: a.city.trim(), postcode: a.postcode.trim().toUpperCase() }; // <-- throws if `a` is undefined
}

app.post('/orders', ah(async (req, res) => {
  const userId = userIdOf(req);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  const items = req.body?.items;

  // Address handling happens BEFORE stock is reserved, so the seeded crash
  // can't leak reserved stock.
  let shipTo;
  if (SEED_BUG_NULL_SHIPPING) {
    shipTo = buildShipTo(req.body.shippingAddress); // unguarded: see SEEDED BUG above
  } else {
    shipTo = validateShipTo(req.body?.shippingAddress);
    if (!shipTo) return res.status(400).json({ error: 'shippingAddress {line1, city, postcode} required' });
  }

  // 1. Reserve stock + get authoritative prices from Product (409 if unavailable).
  let reserved;
  try {
    reserved = await callService(PRODUCT_URL, '/products/reserve', {
      method: 'POST', body: { items }, requestId: req.id,
    });
  } catch (err) {
    if (err.status === 400 || err.status === 409) return res.status(err.status).json({ error: err.message });
    throw err; // Product down/timeout -> 500 via the shared error handler
  }

  // 2. Money, computed HERE from the prices Product returned. The client sends
  //    a promo CODE and a currency, never an amount - anything the browser can
  //    edit is a suggestion, not a rule.
  const subtotalCents = reserved.items.reduce((sum, i) => sum + i.unitPriceCents * i.qty, 0);
  const promo = applyPromo(req.body?.promoCode, subtotalCents);
  const discountCents = promo?.discountCents ?? 0;
  const totalCents = subtotalCents - discountCents;

  const currency = String(req.body?.currency ?? 'USD').toUpperCase();
  if (!isSupportedCurrency(currency)) {
    await releaseStock(items, req.id);
    return res.status(400).json({ error: `unsupported currency "${currency}"` });
  }
  const rate = fxRate(currency);
  const chargedAmount = Number(((totalCents / 100) * rate).toFixed(2));

  // 3. Payment. A DEMO gate, but a real server-side decision: the storefront
  //    renders an actual 402 from this service rather than a scripted error.
  //    Runs after reservation, so a decline must hand the stock back.
  const payment = authorizePayment(req.body?.card);
  if (!payment.ok) {
    await releaseStock(items, req.id);
    // 402 rather than 400: the request was well-formed, the payment was refused.
    return res.status(402).json({
      error: 'payment_declined',
      decline_code: payment.code,
      message: payment.message,
      card_last4: payment.last4,
      request_id: req.id,
    });
  }

  // 4. Persist. If this fails we must give the stock back (compensation),
  //    otherwise stock leaks away on every failed order.
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    const { rows } = await conn.query(
      `INSERT INTO orders
         (user_id, subtotal_cents, discount_cents, total_cents, promo_code,
          currency, fx_rate, charged_amount, shipping_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, status, subtotal_cents, discount_cents, total_cents, promo_code,
                 currency, fx_rate, charged_amount, shipping_address, created_at`,
      [userId, subtotalCents, discountCents, totalCents, promo?.code ?? null,
       currency, rate, chargedAmount, shipTo],
    );
    for (const i of reserved.items) {
      await conn.query(
        'INSERT INTO order_items (order_id, product_id, qty, unit_price_cents) VALUES ($1, $2, $3, $4)',
        [rows[0].id, i.productId, i.qty, i.unitPriceCents],
      );
    }
    await conn.query('COMMIT');
    res.status(201).json({ ...rows[0], items: reserved.items, promo_label: promo?.label ?? null });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    await releaseStock(items, req.id);
    throw err;
  } finally {
    conn.release();
  }
}));

// Deliberately NOT /orders/promo-codes: that would collide with the gateway's
// GET /api/orders/:id rule and get routed to the READ service, which knows
// nothing about promo codes. Its own path keeps the two unambiguous.
app.get('/promo-codes', (req, res) => res.json({ codes: promoCodeNames }));

app.patch('/orders/:id/status', ah(async (req, res) => {
  const userId = userIdOf(req);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  const next = req.body?.status;
  const id = Number(req.params.id) || 0;

  // Filtering on user_id: you can only change your own orders. A foreign id
  // looks the same as a missing one (404), so ids can't be probed.
  const { rows } = await pool.query('SELECT id, status FROM orders WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!rows[0]) return res.status(404).json({ error: 'order not found' });
  if (!TRANSITIONS[rows[0].status]?.includes(next)) {
    return res.status(409).json({ error: `cannot move order from ${rows[0].status} to ${next}` });
  }

  await pool.query('UPDATE orders SET status = $2 WHERE id = $1', [id, next]);
  if (next === 'cancelled') {
    const { rows: items } = await pool.query('SELECT product_id AS "productId", qty FROM order_items WHERE order_id = $1', [id]);
    await callService(PRODUCT_URL, '/products/release', { method: 'POST', body: { items }, requestId: req.id });
  }
  res.json({ id, status: next });
}));

start();
