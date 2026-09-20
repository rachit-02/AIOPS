// Orders service: the READ path (history / listing). Connects with the
// aiops_orders DB role, which has SELECT-only on order_svc - enforced by
// Postgres, so even a bug here cannot alter an order.
import { createService, createPool, asyncHandler as ah } from '../../_shared/index.js';

const pool = createPool();
const { app, start } = createService({ name: 'orders', pool });

const userIdOf = (req) => Number(req.headers['x-user-id']) || null;

app.get('/orders', ah(async (req, res) => {
  const userId = userIdOf(req);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  // Bounded page size: an unbounded list is a latency incident waiting to happen.
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const { rows } = await pool.query(
    `SELECT id, status, subtotal_cents, discount_cents, total_cents, promo_code,
             currency, fx_rate, charged_amount, shipping_address, created_at
      FROM orders WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  res.json({ orders: rows, limit, offset });
}));

app.get('/orders/:id', ah(async (req, res) => {
  const userId = userIdOf(req);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  const id = Number(req.params.id) || 0;
  const { rows } = await pool.query(
    `SELECT id, status, subtotal_cents, discount_cents, total_cents, promo_code,
             currency, fx_rate, charged_amount, shipping_address, created_at
      FROM orders WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rows[0]) return res.status(404).json({ error: 'order not found' });
  const { rows: items } = await pool.query(
    'SELECT product_id, qty, unit_price_cents FROM order_items WHERE order_id = $1 ORDER BY id', [id]);
  res.json({ ...rows[0], items });
}));

start();
