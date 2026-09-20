-- Runs once, on first start of the postgres container (empty data dir).
--
-- DESIGN: one Postgres instance, one SCHEMA + one ROLE per service.
--   * Cheap (a single instance) but still enforces ownership: a role has no
--     privileges on other services' schemas, so the boundary is real, not
--     just a naming convention.
--   * "Orders" (read path) gets SELECT-only on Order's schema: a CQRS-style
--     read model on a shared store. Even a bug in Orders cannot modify orders.
--   * Passwords below are LOCAL-DEV ONLY. A real deployment sources them from
--     a secret manager.

CREATE ROLE aiops_auth    LOGIN PASSWORD 'auth_dev_pw';
CREATE ROLE aiops_user    LOGIN PASSWORD 'user_dev_pw';
CREATE ROLE aiops_product LOGIN PASSWORD 'product_dev_pw';
CREATE ROLE aiops_order   LOGIN PASSWORD 'order_dev_pw';
CREATE ROLE aiops_orders  LOGIN PASSWORD 'orders_dev_pw';

CREATE SCHEMA auth_svc;
CREATE SCHEMA user_svc;
CREATE SCHEMA product_svc;
CREATE SCHEMA order_svc;

-- Unqualified table names in service code resolve to the service's own schema.
ALTER ROLE aiops_auth    SET search_path = auth_svc;
ALTER ROLE aiops_user    SET search_path = user_svc;
ALTER ROLE aiops_product SET search_path = product_svc;
ALTER ROLE aiops_order   SET search_path = order_svc;
ALTER ROLE aiops_orders  SET search_path = order_svc;

-- ---- auth -----------------------------------------------------------------
CREATE TABLE auth_svc.credentials (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  user_id       INTEGER NOT NULL          -- logical reference to user_svc.users (no cross-schema FK: services own their data)
);

-- ---- user -----------------------------------------------------------------
CREATE TABLE user_svc.users (
  id         SERIAL PRIMARY KEY,
  email      TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- product --------------------------------------------------------------
CREATE TABLE product_svc.products (
  id          SERIAL PRIMARY KEY,
  -- SKU doubles as the storefront's image slug: the frontend renders
  -- /images/<sku>.jpg. One identifier rather than a separate image-name
  -- column, so a product cannot point at the wrong photo via a stale mapping.
  sku         TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'general',       -- drives the storefront nav tabs
  description TEXT NOT NULL DEFAULT '',              -- shown in the quick-view modal
  -- Rating and review count live in the product record so "sort by highest
  -- rated" operates on the REAL list from the API rather than a client-side
  -- invention. Constrained so a bad write cannot produce a 7-star product.
  rating       NUMERIC(2,1) NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
  review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock       INTEGER NOT NULL CHECK (stock >= 0)   -- DB-level guard against overselling
);

-- The Arbor catalogue: 24 items across 4 categories. Stock is deliberately
-- finite so the oversell guard in POST /products/reserve is reachable in a demo
-- rather than theoretical.
INSERT INTO product_svc.products (sku, name, category, description, rating, review_count, price_cents, stock) VALUES
  ('tote',         'Canvas Field Tote',            'accessories', 'A heavyweight canvas tote built for daily carry, with reinforced handles and a flat base.',  4.6, 128,  3800, 40),
  ('mug',          'Ceramic Mug, pair',            'home',        'Two hand-glazed stoneware mugs, dishwasher and microwave safe.',                             4.8, 203,  2400, 60),
  ('scarf',        'Merino Wool Scarf',            'apparel',     'Soft merino wool, woven in a small mill, warm without the bulk.',                            4.5,  76,  5200, 30),
  ('shirt',        'Washed Linen Shirt',           'apparel',     'Garment-washed linen that softens with every wear, relaxed fit.',                            4.7, 154,  6400, 25),
  ('belt',         'Saddle Leather Belt',          'accessories', 'Full-grain leather with a solid brass buckle, ages beautifully.',                            4.4,  61,  4600, 35),
  ('beanie',       'Ribbed Knit Beanie',           'apparel',     'A close-ribbed knit beanie in midweight wool blend.',                                        4.6,  98,  2200, 50),
  ('candle',       'Soy Wax Candle',               'home',        'Hand-poured soy wax, 40-hour burn time, cedar and fig.',                                     4.9, 312,  1800, 70),
  ('notebook',     'Dot-Grid Notebook',            'stationery',  '160 pages of dot-grid paper, lays flat, smyth-sewn binding.',                                4.7, 145,  1400, 80),
  ('plant',        'Terracotta Plant Pot',         'home',        'Unglazed terracotta with a drainage saucer, ages with a natural patina.',                    4.5,  87,  2800, 45),
  ('sunglasses',   'Acetate Sunglasses',           'accessories', 'Italian acetate frames with polarized lenses.',                                              4.3,  54,  5800, 22),
  ('socks',        'Organic Cotton Socks, 3-pack', 'apparel',     'Combed organic cotton, reinforced heel and toe.',                                            4.6, 210,  1600, 90),
  ('bookend',      'Brass Bookends',               'home',        'Solid brass, weighted base, holds a full shelf without sliding.',                            4.8,  99,  4100, 18),
  ('backpack',     'Waxed Canvas Backpack',        'accessories', 'Waxed canvas with a padded laptop sleeve and leather trim.',                                 4.7, 167,  8800, 16),
  ('throwblanket', 'Wool Throw Blanket',           'home',        'Woven wool throw, generously sized, reversible pattern.',                                    4.9, 140,  5800, 20),
  ('napkins',      'Linen Napkins, set of 4',      'home',        'Stonewashed linen napkins that soften with every wash.',                                     4.5,  44,  2200, 38),
  ('apron',        'Canvas Utility Apron',         'apparel',     'Heavy canvas apron with a cross-back strap and tool pockets.',                               4.6,  71,  4200, 27),
  ('peacoat',      'Wool Peacoat',                 'apparel',     'Double-breasted wool peacoat, fully lined, classic silhouette.',                             4.7,  88, 12800, 10),
  ('towels',       'Cotton Bath Towels, set of 2', 'home',        'Long-staple cotton towels, dense pile, quick-drying.',                                       4.6, 132,  3400, 33),
  ('cardholder',   'Leather Card Holder',          'accessories', 'Slim vegetable-tanned leather card holder, holds up to 6 cards.',                            4.5,  66,  3200, 44),
  ('pen',          'Fountain Pen',                 'stationery',  'Brass-bodied fountain pen with a fine steel nib, converter included.',                        4.8,  57,  3600, 26),
  ('placemats',    'Woven Placemats, set of 4',    'home',        'Hand-woven cotton placemats, reversible, machine washable.',                                 4.4,  39,  2600, 31),
  ('sneakers',     'Canvas Sneakers',              'apparel',     'Low-top canvas sneakers with a natural rubber sole.',                                        4.6, 201,  5400, 24),
  ('campmug',      'Enamel Camp Mug',              'home',        'Classic enamelware mug with a rolled rim, chip-resistant.',                                  4.7, 178,  1200, 75),
  ('passport',     'Leather Passport Holder',      'accessories', 'Vegetable-tanned leather passport holder with a card slot.',                                 4.5,  48,  2900, 41);

-- ---- order ----------------------------------------------------------------
CREATE TABLE order_svc.orders (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','paid','shipped','delivered','cancelled')),

  -- Canonical money is USD cents, derived server-side from product prices.
  subtotal_cents INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_cents    INTEGER NOT NULL CHECK (total_cents >= 0),   -- subtotal - discount
  promo_code     TEXT,                                        -- validated server-side; never trusted from the client

  -- THE CURRENCY ACTUALLY CHARGED, recorded at the moment of sale.
  -- A display toggle must never rewrite history: if this order is viewed later
  -- with the storefront set to a different currency, what the customer was
  -- actually charged has to survive. So the currency, the rate used AND the
  -- amount in that currency are all stored, rather than recomputed on read.
  currency       TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD','INR')),
  fx_rate        NUMERIC(12,4) NOT NULL DEFAULT 1,   -- units of `currency` per 1 USD, at sale time
  charged_amount NUMERIC(14,2) NOT NULL DEFAULT 0,   -- total_cents converted at fx_rate, in `currency`

  shipping_address JSONB,                   -- {name, line1, city, postcode, phone}
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_idx ON order_svc.orders (user_id, created_at DESC);

CREATE TABLE order_svc.order_items (
  id               SERIAL PRIMARY KEY,
  order_id         INTEGER NOT NULL REFERENCES order_svc.orders(id) ON DELETE CASCADE,
  product_id       INTEGER NOT NULL,
  qty              INTEGER NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL         -- price snapshot: later price changes must not rewrite history
);

-- ---- grants (least privilege) ----------------------------------------------
-- New schemas grant nothing to PUBLIC, so each role sees only what is granted below.
GRANT USAGE ON SCHEMA auth_svc    TO aiops_auth;
GRANT USAGE ON SCHEMA user_svc    TO aiops_user;
GRANT USAGE ON SCHEMA product_svc TO aiops_product;
GRANT USAGE ON SCHEMA order_svc   TO aiops_order, aiops_orders;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth_svc    TO aiops_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA user_svc    TO aiops_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA product_svc TO aiops_product;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA order_svc   TO aiops_order;
GRANT SELECT                         ON ALL TABLES IN SCHEMA order_svc   TO aiops_orders;  -- read path: no writes

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA auth_svc    TO aiops_auth;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA user_svc    TO aiops_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA product_svc TO aiops_product;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA order_svc   TO aiops_order;
