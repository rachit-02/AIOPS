// Product service: catalogue + stock ownership. Only this service may change stock.
import { createService, createPool, asyncHandler as ah } from '../../_shared/index.js';

const pool = createPool();
const { app, start } = createService({ name: 'product', pool });

app.get('/products', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT id, sku, name, category, price_cents, stock FROM products ORDER BY id');
  res.json(rows);
}));

// Normalise [{productId, qty}] -> merged, sorted, validated. Sorting means every
// transaction locks rows in the same order, which prevents deadlocks between
// two orders that contain the same products.
function normaliseItems(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const merged = new Map();
  for (const it of items) {
    const id = Number(it?.productId);
    const qty = Number(it?.qty);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty <= 0) return null;
    merged.set(id, (merged.get(id) || 0) + qty);
  }
  return [...merged].sort(([a], [b]) => a - b);
}

// INTERNAL (Order -> Product). Atomically decrements stock and returns the
// authoritative prices. The price comes from HERE, never from the client, so
// a user cannot buy a monitor for 1 cent.
// `AND stock >= qty` in the UPDATE makes check+decrement one atomic statement:
// no race between "is there stock?" and "take it".
app.post('/products/reserve', ah(async (req, res) => {
  const items = normaliseItems(req.body?.items);
  if (!items) return res.status(400).json({ error: 'items: [{productId, qty}] required' });

  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    const priced = [];
    for (const [productId, qty] of items) {
      const { rows } = await conn.query(
        'UPDATE products SET stock = stock - $2 WHERE id = $1 AND stock >= $2 RETURNING id, name, price_cents',
        [productId, qty],
      );
      if (!rows[0]) {
        await conn.query('ROLLBACK');
        res.locals.error = `insufficient_stock_or_unknown_product:${productId}`;
        return res.status(409).json({ error: `product ${productId} unknown or insufficient stock` });
      }
      priced.push({ productId, qty, unitPriceCents: rows[0].price_cents, name: rows[0].name });
    }
    await conn.query('COMMIT');
    res.json({ items: priced });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}));

// INTERNAL. Compensating action: returns stock when an order fails or is cancelled.
app.post('/products/release', ah(async (req, res) => {
  const items = normaliseItems(req.body?.items);
  if (!items) return res.status(400).json({ error: 'items: [{productId, qty}] required' });
  for (const [productId, qty] of items) {
    await pool.query('UPDATE products SET stock = stock + $2 WHERE id = $1', [productId, qty]);
  }
  res.json({ released: true });
}));

app.get('/products/:id', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT id, sku, name, category, price_cents, stock FROM products WHERE id = $1', [
    Number(req.params.id) || 0,
  ]);
  if (!rows[0]) return res.status(404).json({ error: 'product not found' });
  res.json(rows[0]);
}));

start();
