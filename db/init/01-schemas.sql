-- Runs once, on first start of the postgres container (empty data dir).
--
-- DESIGN: one Postgres instance, one SCHEMA + one ROLE per service.
--   * Cheap (a single RDS instance later) but still enforces ownership: a role
--     has no privileges on other services' schemas, so the boundary is real,
--     not just a naming convention.
--   * "Orders" (read path) gets SELECT-only on Order's schema: a CQRS-style
--     read model on a shared store. Even a bug in Orders cannot modify orders.
--   * Passwords below are LOCAL-DEV ONLY. In AWS they come from Secrets Manager.

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
  -- /images/<sku>.jpg. Keeping one identifier rather than a separate
  -- image-name column means a product cannot end up pointing at the wrong
  -- photo through a mismatched mapping table.
  sku         TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'general',       -- drives the storefront nav tabs
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock       INTEGER NOT NULL CHECK (stock >= 0)   -- DB-level guard against overselling
);
-- The Arbor catalogue. Stock is deliberately finite so the oversell guard in
-- POST /products/reserve is reachable in a demo rather than theoretical.
INSERT INTO product_svc.products (sku, name, category, price_cents, stock) VALUES
  ('tote',    'Canvas Field Tote',   'accessories', 3800, 40),
  ('mug',     'Ceramic Mug, pair',   'home',        2400, 60),
  ('scarf',   'Merino Wool Scarf',   'apparel',     5200, 30),
  ('shirt',   'Washed Linen Shirt',  'apparel',     6400, 25),
  ('belt',    'Saddle Leather Belt', 'accessories', 4600, 35),
  ('beanie',  'Ribbed Knit Beanie',  'apparel',     2200, 50),
  ('throw',   'Cotton Throw',        'home',        5800, 20),
  ('bookend', 'Brass Bookends',      'home',        4100, 18);

-- ---- order ----------------------------------------------------------------
CREATE TABLE order_svc.orders (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','paid','shipped','delivered','cancelled')),
  total_cents INTEGER NOT NULL,
  shipping_address JSONB,                   -- {line1, city, postcode}
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
