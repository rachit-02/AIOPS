/**
 * Arbor storefront.
 *
 * Everything here talks to the real backend through the gateway:
 *   GET  /api/products       -> product service (catalogue, prices, stock)
 *   POST /api/orders         -> order service   (write path, reserves stock)
 *   GET  /api/orders/:id     -> orders service  (read path, SELECT-only role)
 *
 * There is no mock catalogue and no scripted error. In particular, the "submit
 * without a shipping address" demo sends a genuine request and renders whatever
 * the backend actually returns — a 400 when the service is healthy, a real 500
 * with the TypeError when the seeded fault is armed. A hard-coded error string
 * would look identical on screen while proving nothing.
 */

const API = '/api';
const money = (cents) => `$${(cents / 100).toFixed(2)}`;

// ---------------------------------------------------------------------------
// Guest session.
//
// The gateway requires a verified JWT for POST /orders, and strips any
// client-supplied x-user-id — identity can only come from a token it issued.
// The design has no sign-in, so the storefront keeps a throwaway account in
// localStorage and reuses it. That preserves the security model exactly (the
// order really is placed by an authenticated user with their own order
// history) without putting a login wall in front of a demo.
// ---------------------------------------------------------------------------
const SESSION_KEY = 'arbor-session';

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

async function getSession() {
  const stored = localStorage.getItem(SESSION_KEY);
  if (stored) {
    try {
      const s = JSON.parse(stored);
      // A JWT here lasts an hour. Rather than decode and check expiry, probe a
      // cheap authenticated endpoint: if the token has expired the gateway says
      // 401 and we transparently make a new session.
      const probe = await api('/users/me', { token: s.token });
      if (probe.ok) return s;
    } catch {
      /* fall through and create a new session */
    }
  }

  const rand = Math.random().toString(36).slice(2, 10);
  const email = `guest-${Date.now().toString(36)}-${rand}@arbor.local`;
  const password = `pw-${rand}-${Math.random().toString(36).slice(2, 10)}`;

  const reg = await api('/auth/register', {
    method: 'POST',
    body: { email, name: 'Arbor Guest', password },
  });
  if (!reg.ok) throw new Error(`could not create a guest session (${reg.status})`);

  const login = await api('/auth/login', { method: 'POST', body: { email, password } });
  if (!login.ok || !login.data?.token) throw new Error(`could not sign in (${login.status})`);

  const session = { email, token: login.data.token };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let products = [];
let activeCat = 'all';
const cart = new Map(); // productId -> qty

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
async function loadProducts() {
  const grid = $('grid');
  const res = await api('/products');
  if (!res.ok || !Array.isArray(res.data)) {
    grid.setAttribute('aria-busy', 'false');
    grid.innerHTML = `<p class="grid-status error">Could not load the catalogue (${res.status}). Is the product service running?</p>`;
    return;
  }
  products = res.data;
  grid.setAttribute('aria-busy', 'false');
  renderTabs();
  renderGrid();
}

function renderTabs() {
  // Categories come from the data, not a hard-coded list, so adding a product
  // in a new category needs no frontend change.
  const cats = ['all', ...[...new Set(products.map((p) => p.category))].sort()];
  $('navTabs').innerHTML = cats
    .map(
      (c) =>
        `<button class="navtab${c === activeCat ? ' active' : ''}" data-cat="${c}">${
          c === 'all' ? 'All' : c[0].toUpperCase() + c.slice(1)
        }</button>`,
    )
    .join('');
}

/** Image cell. Falls back to a labelled placeholder when no photo exists yet. */
function visual(p, cls) {
  const src = `/images/${p.sku}.jpg`;
  // onerror swaps to the placeholder, so dropping a real photo into
  // public/images/ is the only step needed to replace it — no code change.
  //
  // The parent is captured BEFORE removing the img: remove() detaches the node,
  // after which this.parentElement is null and the placeholder class silently
  // never gets added. The cards then render as blank tiles with no label saying
  // which file is missing — which is the one thing the placeholder is for.
  return `<div class="${cls}" data-sku="${p.sku}">
    <img src="${src}" alt="${p.name}" loading="lazy"
         onerror="var b=this.parentElement; this.remove(); if(b) b.classList.add('placeholder');" />
  </div>`;
}

function renderGrid() {
  const list = products.filter((p) => activeCat === 'all' || p.category === activeCat);
  const grid = $('grid');
  if (!list.length) {
    grid.innerHTML = `<p class="grid-status">Nothing in this category.</p>`;
    return;
  }
  grid.innerHTML = list
    .map((p) => {
      const out = p.stock <= 0;
      return `<article class="card">
        ${visual(p, 'card-visual')}
        <div class="card-body">
          <div class="card-tag">${p.category}</div>
          <div class="card-name">${p.name}</div>
          <div class="card-price">${money(p.price_cents)}</div>
          <div class="card-stock${p.stock <= 5 ? ' low' : ''}">${
            out ? 'Out of stock' : `${p.stock} in stock`
          }</div>
          <button class="card-add" data-id="${p.id}" ${out ? 'disabled' : ''}>
            ${out ? 'Unavailable' : 'Add to cart'}
          </button>
        </div>
      </article>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------
const productById = (id) => products.find((p) => p.id === Number(id));

function addToCart(id) {
  const p = productById(id);
  if (!p) return;
  const next = (cart.get(p.id) ?? 0) + 1;
  // Client-side guard only. The authoritative check is the atomic
  // `UPDATE ... WHERE stock >= qty` in the product service, which is what
  // actually prevents overselling under concurrency.
  if (next > p.stock) return;
  cart.set(p.id, next);
  updateCartCount();
  openDrawer('cart');
}

function updateCartCount() {
  $('cartCount').textContent = [...cart.values()].reduce((a, b) => a + b, 0);
}

const subtotal = () =>
  [...cart.entries()].reduce((sum, [id, qty]) => {
    const p = productById(id);
    return sum + (p ? p.price_cents * qty : 0);
  }, 0);

function renderCart() {
  const list = $('cartList');
  if (cart.size === 0) {
    list.innerHTML = '<div class="empty-cart">Your cart is empty.</div>';
  } else {
    list.innerHTML = [...cart.entries()]
      .map(([id, qty]) => {
        const p = productById(id);
        if (!p) return '';
        return `<div class="cart-row">
          ${visual(p, 'cart-row-visual')}
          <div class="cart-row-meta">
            <div class="n">${p.name}</div>
            <div class="p">${money(p.price_cents)}</div>
          </div>
          <div class="qty">
            <button data-id="${id}" data-d="-1" aria-label="Remove one ${p.name}">−</button>
            <span>${qty}</span>
            <button data-id="${id}" data-d="1" aria-label="Add one ${p.name}" ${
              qty >= p.stock ? 'disabled' : ''
            }>+</button>
          </div>
        </div>`;
      })
      .join('');
  }
  $('subtotal').textContent = money(subtotal());
  $('primaryAction').disabled = cart.size === 0;
}

// ---------------------------------------------------------------------------
// Drawer state machine
// ---------------------------------------------------------------------------
const VIEWS = { cart: 'viewCart', checkout: 'viewCheckout', confirm: 'viewConfirm' };
let currentView = 'cart';
let lastFocused = null;

function openDrawer(view) {
  lastFocused = document.activeElement;
  $('drawer').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  $('scrim').classList.add('open');
  setView(view || 'cart');
}

function closeDrawer() {
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  $('scrim').classList.remove('open');
  lastFocused?.focus?.();
}

function setView(view) {
  currentView = view;
  Object.values(VIEWS).forEach((id) => $(id).classList.remove('active'));
  $(VIEWS[view]).classList.add('active');

  const title = $('drawerTitle');
  const primary = $('primaryAction');
  const secondary = $('secondaryAction');
  const foot = $('drawerFoot');
  hideError();
  primary.disabled = false;

  if (view === 'cart') {
    title.textContent = 'Your cart';
    primary.textContent = 'Checkout';
    primary.hidden = false;
    secondary.hidden = true;
    foot.hidden = false;
    renderCart();
  } else if (view === 'checkout') {
    title.textContent = 'Shipping details';
    primary.textContent = 'Place order';
    primary.hidden = false;
    secondary.hidden = false;
    foot.hidden = false;
    setTimeout(() => $('fName').focus(), 0);
  } else {
    title.textContent = 'Order confirmed';
    foot.hidden = true;
  }
}

function showError(html) {
  const box = $('errorBox');
  box.innerHTML = html;
  box.classList.add('show');
}
function hideError() {
  $('errorBox').classList.remove('show');
  $('errorBox').innerHTML = '';
}

// ---------------------------------------------------------------------------
// Checkout — the real call
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function placeOrder() {
  const primary = $('primaryAction');
  const omitAddress = $('fSeedBug').checked;

  const line1 = $('fAddr1').value.trim();
  const city = $('fCity').value.trim();
  const postcode = $('fState').value.trim();

  const items = [...cart.entries()].map(([productId, qty]) => ({ productId, qty }));
  if (!items.length) return;

  // When the demo box is ticked, shippingAddress is omitted ENTIRELY — the same
  // request a buggy client would send. What comes back is the backend's real
  // behaviour: 400 while the service is healthy, 500 with the TypeError once
  // the seeded fault is armed.
  const body = omitAddress ? { items } : { items, shippingAddress: { line1, city, postcode } };

  primary.disabled = true;
  primary.textContent = 'Placing order…';
  hideError();

  try {
    const session = await getSession();
    const res = await api('/orders', { method: 'POST', body, token: session.token });

    if (!res.ok) {
      // Render the ACTUAL status and payload. The 500 body is deliberately
      // terse (`{"error":"internal_error","request_id":"…"}`) because the
      // service must not leak stack traces to clients — the request_id is the
      // handle an operator, or Kira, uses to find the full trace in Loki.
      const payload = res.data ? JSON.stringify(res.data, null, 2) : '(empty response body)';
      const rid = res.data?.request_id;
      showError(
        `Order failed — HTTP ${res.status}\n${escapeHtml(payload)}` +
          (rid
            ? `<span class="req-id">request_id ${escapeHtml(rid)} — searchable in Loki and in Kira's fetch_logs</span>`
            : ''),
      );
      return;
    }

    await showConfirmation(res.data.id, session.token);
    cart.clear();
    updateCartCount();
    await loadProducts(); // stock actually changed; re-read it
  } catch (err) {
    showError(`Order failed — ${escapeHtml(err.message)}`);
  } finally {
    primary.disabled = false;
    primary.textContent = 'Place order';
  }
}

/**
 * Confirmation reads the order back from the Orders (read) service rather than
 * echoing the POST response. That proves the write landed and is visible on the
 * read path — the CQRS split doing real work, not just an architecture diagram.
 */
async function showConfirmation(orderId, token) {
  setView('confirm');
  $('orderNo').textContent = `Order #${orderId}`;
  const detail = $('confirmDetail');
  detail.innerHTML = '<p class="confirm-note">Reading the order back…</p>';

  const res = await api(`/orders/${orderId}`, { token });
  if (!res.ok) {
    detail.innerHTML = `<p class="confirm-note">Placed, but the read service returned ${res.status}.</p>`;
    return;
  }
  const o = res.data;
  const lines = (o.items ?? [])
    .map((it) => {
      const p = products.find((x) => x.id === it.product_id);
      return `<div class="confirm-line"><span>${escapeHtml(p?.name ?? `Product ${it.product_id}`)} × ${it.qty}</span><span class="muted">${money(it.unit_price_cents * it.qty)}</span></div>`;
    })
    .join('');
  const addr = o.shipping_address;
  detail.innerHTML = `
    <div class="confirm-lines">
      ${lines}
      <div class="confirm-line"><span><strong>Total</strong></span><span><strong>${money(o.total_cents)}</strong></span></div>
      <div class="confirm-line"><span class="muted">Status</span><span class="muted">${escapeHtml(o.status)}</span></div>
      ${
        addr
          ? `<div class="confirm-line"><span class="muted">Ships to</span><span class="muted">${escapeHtml(
              [addr.line1, addr.city, addr.postcode].filter(Boolean).join(', '),
            )}</span></div>`
          : ''
      }
    </div>`;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$('grid').addEventListener('click', (e) => {
  const btn = e.target.closest('.card-add');
  if (btn && !btn.disabled) addToCart(btn.dataset.id);
});

$('navTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.navtab');
  if (!btn) return;
  activeCat = btn.dataset.cat;
  renderTabs();
  renderGrid();
});

$('cartList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-d]');
  if (!b) return;
  const id = Number(b.dataset.id);
  const next = (cart.get(id) ?? 0) + Number(b.dataset.d);
  if (next <= 0) cart.delete(id);
  else cart.set(id, next);
  updateCartCount();
  renderCart();
});

$('cartBtn').addEventListener('click', () => openDrawer('cart'));
$('closeDrawer').addEventListener('click', closeDrawer);
$('scrim').addEventListener('click', closeDrawer);
$('secondaryAction').addEventListener('click', () => setView('cart'));

$('primaryAction').addEventListener('click', () => {
  if (currentView === 'cart') {
    if (cart.size === 0) return;
    setView('checkout');
  } else if (currentView === 'checkout') {
    placeOrder();
  }
});

$('checkoutForm').addEventListener('submit', (e) => {
  e.preventDefault();
  placeOrder();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});

// Theme: explicit choice wins, then the OS preference (handled in CSS).
const storedTheme = localStorage.getItem('arbor-theme');
if (storedTheme) document.documentElement.dataset.theme = storedTheme;
$('themeBtn').addEventListener('click', () => {
  const root = document.documentElement;
  const isDark =
    root.dataset.theme === 'dark' ||
    (!root.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = isDark ? 'light' : 'dark';
  localStorage.setItem('arbor-theme', root.dataset.theme);
});

// The ops dashboard runs on a separate port in local dev; allow an override so
// this still points somewhere sensible if it is hosted elsewhere.
const dash = new URLSearchParams(location.search).get('dashboard');
if (dash) $('systemLink').href = dash;

loadProducts();
updateCartCount();
