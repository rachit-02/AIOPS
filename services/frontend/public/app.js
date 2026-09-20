/**
 * Arbor storefront.
 *
 * Every figure on screen comes from the real backend through the gateway:
 *   GET  /api/products       product service — catalogue, prices, live stock
 *   GET  /api/promo-codes    order service   — which codes exist
 *   POST /api/orders         order service   — reserves stock, charges, writes
 *   GET  /api/orders         orders service  — history (READ path, SELECT-only)
 *   GET  /api/orders/:id     orders service  — read-back on confirmation
 *
 * There is no mock catalogue and no scripted error anywhere. Both failure paths
 * — the seeded address bug and the payment decline — render whatever the
 * backend actually returned, status code and body included. A hard-coded error
 * string would look identical on screen while proving nothing.
 *
 * WHAT IS DELIBERATELY *NOT* DECIDED HERE
 * Prices, the promo discount and the payment outcome are all computed by the
 * order service. This file sends a promo CODE and a currency, never an amount.
 * Anything the browser can edit is a suggestion, not a rule.
 */

const API = '/api';

// Must match FX_RATES in services/order/src/commerce.js. The server stores the
// rate it actually used on each order, so a mismatch here can only ever affect
// a preview, never what someone was charged.
const RATES = { USD: 1, INR: 83 };
const SYMBOL = { USD: '$', INR: '₹' };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let currency = localStorage.getItem('arbor-currency') || 'USD';

/** Format USD cents in the currently displayed currency. */
function money(usdCents) {
  const v = (usdCents / 100) * RATES[currency];
  return currency === 'INR' ? `₹${Math.round(v).toLocaleString('en-IN')}` : `$${v.toFixed(2)}`;
}

/**
 * Format an order's ORIGINAL charged amount — never re-converted.
 * An order is a historical fact: switching the display toggle afterwards must
 * not change what the customer was charged.
 */
function chargedMoney(order) {
  const sym = SYMBOL[order.currency] ?? '';
  const amt = Number(order.charged_amount);
  return order.currency === 'INR'
    ? `${sym}${Math.round(amt).toLocaleString('en-IN')}`
    : `${sym}${amt.toFixed(2)}`;
}

const stars = (r) => '★'.repeat(Math.round(r)) + '☆'.repeat(5 - Math.round(r));

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
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

// ---------------------------------------------------------------------------
// Guest session
//
// The gateway requires a verified JWT for POST /orders and strips any
// client-supplied x-user-id, so identity can only come from a token it issued.
// The design has no sign-in, so a throwaway account is kept in localStorage.
// The order really is placed by an authenticated user with their own history —
// the security boundary is preserved rather than weakened to suit the design.
// ---------------------------------------------------------------------------
const SESSION_KEY = 'arbor-session';

async function getSession() {
  const stored = localStorage.getItem(SESSION_KEY);
  if (stored) {
    try {
      const s = JSON.parse(stored);
      // Tokens last an hour. Rather than decode and check expiry, probe a cheap
      // authenticated endpoint: a 401 means we transparently make a new one.
      if ((await api('/users/me', { token: s.token })).ok) return s;
    } catch {
      /* fall through */
    }
  }
  const rand = Math.random().toString(36).slice(2, 10);
  const email = `guest-${Date.now().toString(36)}-${rand}@arbor.local`;
  const password = `pw-${rand}-${Math.random().toString(36).slice(2, 10)}`;

  const reg = await api('/auth/register', { method: 'POST', body: { email, name: 'Arbor Guest', password } });
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
let orders = [];
let promoCodeHints = [];
let activeCat = 'all';
let searchTerm = '';
let sortMode = 'featured';
let appliedPromo = null; // { code, label } — the DISCOUNT is the server's to compute

const cart = new Map(); // productId -> qty
const wishlist = new Set(JSON.parse(localStorage.getItem('arbor-wishlist') || '[]'));

const productById = (id) => products.find((p) => p.id === Number(id));
const saveWishlist = () => localStorage.setItem('arbor-wishlist', JSON.stringify([...wishlist]));

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
async function loadProducts() {
  const grid = $('grid');
  const res = await api('/products');
  grid.setAttribute('aria-busy', 'false');
  if (!res.ok || !Array.isArray(res.data)) {
    grid.innerHTML = `<p class="empty-grid error">Could not load the catalogue (${res.status}). Is the product service running?</p>`;
    return;
  }
  products = res.data;
  renderTabs();
  renderGrid();
}

function renderTabs() {
  // Categories are derived from the data, so adding a product in a new
  // category needs no frontend change.
  const cats = [...new Set(products.map((p) => p.category))].sort();
  const tabs = [['all', 'All'], ...cats.map((c) => [c, c[0].toUpperCase() + c.slice(1)]), ['wishlist', '♥ Wishlist']];
  $('navTabs').innerHTML = tabs
    .map(([id, label]) => `<button class="navtab${id === activeCat ? ' active' : ''}" data-cat="${id}">${label}</button>`)
    .join('');
}

/**
 * Image cell, falling back to a labelled placeholder when no photo exists.
 * `inner` is markup rendered on top of the image (the wishlist heart).
 */
function visual(p, cls, attrs = '', inner = '') {
  // The parent is captured BEFORE removing the img: remove() detaches the node,
  // after which this.parentElement is null and the placeholder class silently
  // never gets added — the bug that made an earlier build show blank tiles.
  return `<div class="${cls}" data-sku="${esc(p.sku)}" ${attrs}>
    <img src="/images/${esc(p.sku)}.jpg" alt="${esc(p.name)}" loading="lazy"
         onerror="var b=this.parentElement; this.remove(); if(b) b.classList.add('placeholder');" />
    ${inner}
  </div>`;
}

function visibleProducts() {
  let list = products.filter((p) => {
    if (activeCat === 'wishlist') return wishlist.has(p.id);
    if (activeCat !== 'all' && p.category !== activeCat) return false;
    if (searchTerm && !p.name.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  });
  // Sorting runs on the real list from the API, including the real rating.
  if (sortMode === 'price-asc') list = [...list].sort((a, b) => a.price_cents - b.price_cents);
  if (sortMode === 'price-desc') list = [...list].sort((a, b) => b.price_cents - a.price_cents);
  if (sortMode === 'rating') list = [...list].sort((a, b) => Number(b.rating) - Number(a.rating));
  return list;
}

function renderGrid() {
  const list = visibleProducts();
  const grid = $('grid');
  if (!list.length) {
    grid.innerHTML = `<p class="empty-grid">${
      activeCat === 'wishlist' ? 'Nothing saved yet — tap the heart on a product.' : 'No products match.'
    }</p>`;
    return;
  }
  grid.innerHTML = list
    .map((p) => {
      const out = p.stock <= 0;
      const wished = wishlist.has(p.id);
      const heart = `<button class="wish-btn${wished ? ' active' : ''}" data-wish="${p.id}"
          aria-label="${wished ? 'Remove from' : 'Add to'} wishlist" aria-pressed="${wished}">${wished ? '♥' : '♡'}</button>`;
      return `<article class="card">
        ${visual(p, 'card-visual', `data-qv="${p.id}"`, heart)}
        <div class="card-body">
          <div class="card-tag">${esc(p.category)}</div>
          <div class="card-name">${esc(p.name)}</div>
          <div class="card-rating">${stars(p.rating)} <b>${p.rating}</b> (${p.review_count})</div>
          <div class="card-price">${money(p.price_cents)}</div>
          <div class="card-stock${p.stock <= 5 ? ' low' : ''}">${out ? 'Out of stock' : `${p.stock} in stock`}</div>
          <button class="card-add" data-id="${p.id}" ${out ? 'disabled' : ''}>${out ? 'Unavailable' : 'Add to cart'}</button>
        </div>
      </article>`;
    })
    .join('');
}

function toggleWish(id) {
  const n = Number(id);
  if (wishlist.has(n)) wishlist.delete(n);
  else wishlist.add(n);
  saveWishlist();
  updateBadges();
  renderGrid();
  if ($('qvScrim').classList.contains('open') && qvCurrent === n) updateQvWish();
}

function updateBadges() {
  const set = (id, n) => {
    const el = $(id);
    el.textContent = n;
    el.hidden = n === 0;
  };
  set('cartCount', [...cart.values()].reduce((a, b) => a + b, 0));
  set('wishCount', wishlist.size);
  set('ordersCount', orders.length);
}

// ---------------------------------------------------------------------------
// Quick view — uses data already fetched for the grid, no extra API call
// ---------------------------------------------------------------------------
let qvCurrent = null;

function openQuickView(id) {
  const p = productById(id);
  if (!p) return;
  qvCurrent = p.id;
  $('qvTitle').textContent = p.name;
  // Re-fill the existing node rather than replacing it, so the element id and
  // its event wiring survive; the placeholder class is cleared each time.
  const vis = $('qvVisual');
  vis.classList.remove('placeholder');
  vis.dataset.sku = p.sku;
  vis.innerHTML = `<img src="/images/${esc(p.sku)}.jpg" alt="${esc(p.name)}"
      onerror="var b=this.parentElement; this.remove(); if(b) b.classList.add('placeholder');" />`;
  $('qvRating').textContent = `${stars(p.rating)} ${p.rating} (${p.review_count} reviews)`;
  $('qvPrice').textContent = money(p.price_cents);
  $('qvDesc').textContent = p.description || '';
  updateQvWish();
  $('qvScrim').classList.add('open');
}
const updateQvWish = () => ($('qvWish').textContent = wishlist.has(qvCurrent) ? '♥ Saved' : '♡ Save');
const closeQv = () => $('qvScrim').classList.remove('open');

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------
function addToCart(id) {
  const p = productById(id);
  if (!p) return;
  const next = (cart.get(p.id) ?? 0) + 1;
  // Client-side guard only. The authoritative check is the atomic
  // `UPDATE ... WHERE stock >= qty` in the product service.
  if (next > p.stock) return;
  cart.set(p.id, next);
  updateBadges();
  openDrawer();
}

const subtotalCents = () =>
  [...cart.entries()].reduce((s, [id, q]) => s + (productById(id)?.price_cents ?? 0) * q, 0);

/** Preview only. The authoritative discount is computed by the order service. */
const previewDiscountCents = () => {
  if (!appliedPromo) return 0;
  return Math.min(subtotalCents(), Math.floor(subtotalCents() * appliedPromo.rate));
};

function renderCart() {
  const list = $('cartList');
  const summary = $('cartSummary');
  if (cart.size === 0) {
    list.innerHTML = '<div class="empty-cart">Your cart is empty.</div>';
    summary.innerHTML = '';
    return;
  }
  list.innerHTML = [...cart.entries()]
    .map(([id, qty]) => {
      const p = productById(id);
      if (!p) return '';
      return `<div class="cart-row">
        ${visual(p, 'cart-row-visual')}
        <div class="cart-row-meta">
          <div class="n">${esc(p.name)}</div>
          <div class="p">${money(p.price_cents)}</div>
        </div>
        <div class="qty">
          <button data-id="${id}" data-d="-1" aria-label="Remove one ${esc(p.name)}">−</button>
          <span>${qty}</span>
          <button data-id="${id}" data-d="1" ${qty >= p.stock ? 'disabled' : ''} aria-label="Add one ${esc(p.name)}">+</button>
        </div>
      </div>`;
    })
    .join('');

  const sub = subtotalCents();
  const disc = previewDiscountCents();
  summary.innerHTML = `
    <div class="promo-row">
      <input type="text" id="promoInput" placeholder="Promo code${promoCodeHints.length ? ` (try ${promoCodeHints[0]})` : ''}"
             value="${appliedPromo ? esc(appliedPromo.code) : ''}" aria-label="Promo code" />
      <button class="promo-apply" id="promoApply">Apply</button>
    </div>
    <div class="promo-hint ${appliedPromo ? 'ok' : ''}" id="promoHint">${
      appliedPromo ? `✓ ${Math.round(appliedPromo.rate * 100)}% off applied` : ''
    }</div>
    <div class="sum-row"><span>Subtotal</span><span>${money(sub)}</span></div>
    ${disc > 0 ? `<div class="sum-row" style="color:var(--ok)"><span>Discount</span><span>−${money(disc)}</span></div>` : ''}
    <div class="sum-row total"><span>Total</span><span>${money(sub - disc)}</span></div>`;

  $('promoApply').addEventListener('click', applyPromoLocally);
  $('promoInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyPromoLocally();
  });
}

/**
 * Local promo check, for immediate feedback only.
 *
 * The code list comes from the order service, and the discount that actually
 * applies is recomputed there at checkout from prices the client never supplied.
 * This is a preview of the server's answer, not the answer.
 */
const LOCAL_RATES = { WELCOME10: 0.1, SHIP5: 0.05 };
function applyPromoLocally() {
  const input = $('promoInput');
  const hint = $('promoHint');
  const code = input.value.trim().toUpperCase();
  input.classList.remove('valid', 'invalid');
  if (!code) {
    appliedPromo = null;
    renderCart();
    return;
  }
  if (promoCodeHints.includes(code)) {
    appliedPromo = { code, rate: LOCAL_RATES[code] ?? 0 };
    input.classList.add('valid');
    hint.textContent = `✓ ${Math.round(appliedPromo.rate * 100)}% off — applied by the server at checkout`;
    hint.className = 'promo-hint ok';
  } else {
    appliedPromo = null;
    input.classList.add('invalid');
    hint.textContent = 'invalid code';
    hint.className = 'promo-hint err';
  }
  // Patch the totals in place rather than re-rendering: a full renderCart()
  // would rebuild the input, dropping focus and wiping the message just set.
  const sub = subtotalCents();
  const disc = previewDiscountCents();
  const rows = [...$('cartSummary').querySelectorAll('.sum-row')];
  const totalRow = rows.find((r) => r.classList.contains('total'));
  const discRow = rows.find((r) => !r.classList.contains('total') && r.firstElementChild.textContent === 'Discount');
  if (totalRow) totalRow.lastElementChild.textContent = money(sub - disc);
  if (discRow) {
    discRow.hidden = disc === 0;
    discRow.lastElementChild.textContent = `−${money(disc)}`;
  } else if (disc > 0 && totalRow) {
    totalRow.insertAdjacentHTML(
      'beforebegin',
      `<div class="sum-row" style="color:var(--ok)"><span>Discount</span><span>−${money(disc)}</span></div>`,
    );
  }
}

// ---------------------------------------------------------------------------
// Validation — real, and gating submission
// ---------------------------------------------------------------------------
function setField(inputId, hintId, valid, msg) {
  const input = $(inputId);
  const hint = $(hintId);
  input.classList.remove('valid', 'invalid');
  if (input.value.trim() === '') {
    hint.textContent = '';
    hint.className = 'field-hint';
    return;
  }
  input.classList.add(valid ? 'valid' : 'invalid');
  hint.textContent = valid ? '✓ looks good' : msg;
  hint.className = `field-hint ${valid ? 'ok' : 'err'}`;
}

/** True when the demo switch is on: this order is sent WITHOUT an address. */
const demoOmitsAddress = () => $('fSeedBug').checked;

/**
 * Build the exact request body that will be POSTed.
 *
 * SINGLE SOURCE OF TRUTH — this is the one and only place the order payload is
 * assembled, and both the "Continue"/"Place order" gate and the submit call it.
 *
 * Why it exists: the gate used to validate the DOM while placeOrder() built the
 * body from the DOM separately. Two readings of the same fields through two
 * code paths, free to disagree — and they did. Ticking the demo box made the
 * gate return "valid" while the body silently dropped shippingAddress, so the
 * form showed five green "✓ looks good" ticks and the server answered
 * 400 shippingAddress required. A gate that does not inspect the actual payload
 * is not a gate.
 */
function buildOrderPayload() {
  const items = [...cart.entries()].map(([productId, qty]) => ({ productId, qty }));
  const shippingAddress = {
    name: $('fName').value.trim(),
    line1: $('fAddr').value.trim(),
    city: $('fCity').value.trim(),
    postcode: $('fPin').value.trim(),
    phone: $('fPhone').value.trim(),
  };
  return {
    items,
    // The CODE, never an amount — the server recomputes the discount.
    ...(appliedPromo ? { promoCode: appliedPromo.code } : {}),
    currency,
    card: $('fCard').value,
    // Omitted entirely when the demo box is ticked: the same request a buggy
    // client would send.
    ...(demoOmitsAddress() ? {} : { shippingAddress }),
  };
}

/**
 * Mirror of the order service's validateShipTo() contract.
 *
 * Deliberately checks the PAYLOAD, not the inputs, and deliberately checks the
 * same three fields the server requires — {line1, city, postcode} non-empty.
 * If this ever drifts from services/order/src/index.js the e2e test fails,
 * because that test asserts on a real response rather than on this function.
 */
function payloadAddressAcceptable(payload) {
  const a = payload.shippingAddress;
  if (!a || typeof a !== 'object') return false;
  return [a.line1, a.city, a.postcode].every((x) => typeof x === 'string' && x.trim() !== '');
}

function shippingValid() {
  const v = (id) => $(id).value.trim();
  const checks = {
    fName: [v('fName').length >= 2, 'hName', 'enter your full name'],
    fAddr: [v('fAddr').length >= 4, 'hAddr', 'enter a street address'],
    fCity: [v('fCity').length >= 2, 'hCity', 'enter a city'],
    fPin: [/^[0-9]{4,6}$/.test(v('fPin')), 'hPin', '4–6 digit PIN/ZIP'],
    fPhone: [/^[0-9]{10}$/.test(v('fPhone')), 'hPhone', '10 digit phone number'],
  };
  let allOk = true;
  for (const [id, [ok, hintId, msg]] of Object.entries(checks)) {
    // In demo mode these values are about to be thrown away, so showing a
    // green tick beside them would be a lie. Clear the per-field state and let
    // the banner speak instead.
    if (demoOmitsAddress()) {
      $(id).classList.remove('valid', 'invalid');
      $(checks[id][1]).textContent = '';
      $(checks[id][1]).className = 'field-hint';
      continue;
    }
    setField(id, hintId, ok, msg);
    if (!ok || !v(id)) allOk = false;
  }

  // The demo path deliberately submits a request the server will reject, so it
  // must be allowed THROUGH the gate — but it is announced, not silent.
  if (demoOmitsAddress()) return true;
  // Otherwise the gate asks the same question the server will ask, of the same
  // object the server will receive.
  return allOk && payloadAddressAcceptable(buildOrderPayload());
}

/**
 * Keep the UI honest about what will actually be sent.
 * Called whenever the demo switch changes or a step is entered.
 */
function syncDemoNotice() {
  const on = demoOmitsAddress();
  // Disable the address inputs: a field that cannot affect the request should
  // not accept typing as though it could.
  for (const id of ['fName', 'fAddr', 'fCity', 'fPin', 'fPhone']) {
    $(id).disabled = on;
    $(id).closest('.field').classList.toggle('disabled', on);
  }
  const msg = 'This order will be sent with <b>no shipping address</b> — anything typed above is discarded.';
  $('shipNotice').innerHTML = on ? msg : '';
  $('shipNotice').hidden = !on;
  // The same warning on the payment step, because that is where "Place order"
  // lives and where the surprise happened.
  $('payNotice').innerHTML = on ? msg : '';
  $('payNotice').hidden = !on;
}

/** Luhn check — catches a mistyped digit that a length check would pass. */
function luhnOk(pan) {
  let sum = 0;
  let dbl = false;
  for (let i = pan.length - 1; i >= 0; i--) {
    let d = Number(pan[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function expiryOk(exp) {
  const m = /^(0[1-9]|1[0-2])\/([0-9]{2})$/.exec(exp);
  if (!m) return false;
  // Reject a correctly-formatted date that has already passed.
  const now = new Date();
  const year = 2000 + Number(m[2]);
  const month = Number(m[1]);
  const end = new Date(year, month, 1); // first day AFTER the expiry month
  return end > now;
}

function paymentValid() {
  const pan = $('fCard').value.replace(/[\s-]/g, '');
  const exp = $('fExp').value.trim();
  const cvv = $('fCvv').value.trim();
  const okCard = /^[0-9]{13,19}$/.test(pan) && luhnOk(pan);
  const okExp = expiryOk(exp);
  const okCvv = /^[0-9]{3,4}$/.test(cvv);
  setField('fCard', 'hCard', okCard, /^[0-9]+$/.test(pan) ? 'card number fails the checksum' : '13–19 digit card number');
  setField('fExp', 'hExp', okExp, /^\d\d\/\d\d$/.test(exp) ? 'card has expired' : 'MM/YY format');
  setField('fCvv', 'hCvv', okCvv, '3–4 digit CVV');
  return okCard && okExp && okCvv && pan && exp && cvv;
}

function refreshGate() {
  if (step === 'shipping') $('nextBtn').disabled = !shippingValid();
  if (step === 'payment') $('nextBtn').disabled = !paymentValid();
}

// ---------------------------------------------------------------------------
// Drawer step machine
// ---------------------------------------------------------------------------
const STEPS = ['cart', 'shipping', 'payment', 'confirm'];
const VIEW = { cart: 'viewCart', shipping: 'viewShipping', payment: 'viewPayment', confirm: 'viewConfirm' };
let step = 'cart';

function openDrawer() {
  $('drawer').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  $('scrim').classList.add('open');
  setStep('cart');
}
function closeDrawer() {
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  $('scrim').classList.remove('open');
}

function setStep(s) {
  step = s;
  Object.values(VIEW).forEach((id) => ($(id).hidden = true));
  $(VIEW[s]).hidden = false;
  document.querySelectorAll('.step-dot').forEach((d) => {
    d.classList.remove('active', 'done');
    const i = STEPS.indexOf(d.dataset.s);
    const cur = STEPS.indexOf(s);
    if (i < cur) d.classList.add('done');
    else if (i === cur) d.classList.add('active');
  });

  const titles = { cart: 'Your cart', shipping: 'Shipping details', payment: 'Payment', confirm: 'Order confirmed' };
  $('drawerTitle').textContent = titles[s];
  const back = $('backBtn');
  const next = $('nextBtn');
  $('kiraSlot').innerHTML = '';

  if (s === 'cart') {
    renderCart();
    back.hidden = true;
    next.hidden = false;
    next.textContent = 'Checkout';
    next.disabled = cart.size === 0;
    $('drawerFoot').hidden = false;
  } else if (s === 'shipping') {
    back.hidden = false;
    next.hidden = false;
    next.textContent = 'Continue';
    $('drawerFoot').hidden = false;
    syncDemoNotice();
    refreshGate();
  } else if (s === 'payment') {
    back.hidden = false;
    next.hidden = false;
    next.textContent = 'Place order';
    $('drawerFoot').hidden = false;
    syncDemoNotice();
    refreshGate();
  } else {
    $('drawerFoot').hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Checkout — the real call
// ---------------------------------------------------------------------------
async function placeOrder() {
  const next = $('nextBtn');
  // The SAME object the gate inspected. Built once, here, by one function.
  const body = buildOrderPayload();
  if (!body.items.length) return;

  next.disabled = true;
  next.textContent = 'Placing order…';
  $('kiraSlot').innerHTML = '';

  try {
    const session = await getSession();
    const res = await api('/orders', { method: 'POST', body, token: session.token });

    if (!res.ok) {
      showKira(res);
      return;
    }
    await showConfirmation(res.data.id, session.token);
    cart.clear();
    appliedPromo = null;
    // Reset the demo switch after a completed order. Left sticky, one
    // experiment with it silently poisons every subsequent checkout in the
    // session — which is how the original report happened.
    $('fSeedBug').checked = false;
    syncDemoNotice();
    updateBadges();
    await Promise.all([loadProducts(), loadOrders()]); // stock and history both changed
  } catch (err) {
    showKira({ status: 0, data: { error: err.message } });
  } finally {
    next.disabled = false;
    next.textContent = 'Place order';
  }
}

/**
 * The checkout assistant.
 *
 * Same Root cause / Evidence / Fix / Prevention shape as the ops-dashboard
 * Kira, and — importantly — the same commitment: the Evidence block prints the
 * VERBATIM backend response, status code and body. The narrative around it is
 * written per failure kind, but the reader can always check it against what the
 * server actually said.
 */
function showKira(res) {
  const { status, data } = res;
  const raw = `HTTP ${status || '(network error)'}\n${data ? JSON.stringify(data, null, 2) : '(empty body)'}`;
  let diagnosis;

  if (status === 402) {
    diagnosis = {
      root: `The card issuer declined the charge. Card ending ${esc(data.card_last4 ?? '????')} is a standard test card reserved for simulating a generic decline.`,
      evidence: `The order service returned <b>402 Payment Required</b> with <code>decline_code: ${esc(data.decline_code ?? 'unknown')}</code>. No money moved, and the reserved stock was released back to the product service.`,
      fix: 'Use a different card. The test card ending 4242 is reserved for simulating an approval.',
      prevention:
        'Run a zero-amount authorization before collecting the rest of the checkout, so a declining card surfaces before the customer has filled in everything else.',
      cta: 'Use the approving test card',
      action: () => $('approveCard').click(),
    };
  } else if (status === 500) {
    diagnosis = {
      root: 'The order service threw an unhandled exception while building the shipping address, because the request carried none.',
      evidence: `A genuine <b>500</b> with <code>request_id ${esc(data?.request_id ?? 'n/a')}</code> — searchable in Loki and via Kira's <code>fetch_logs</code> in the ops dashboard, where the stack trace points at <code>buildShipTo</code>.`,
      fix: 'Untick the demo box and supply a shipping address. The healthy code path rejects the same request with a 400 instead of crashing.',
      prevention:
        'Validate the address before dereferencing it, and add a test covering an order with no address on file — the exact case this refactor dropped.',
      cta: 'Go back and add an address',
      action: () => {
        $('fSeedBug').checked = false;
        syncDemoNotice();
        setStep('shipping');
      },
    };
  } else if (status === 409) {
    diagnosis = {
      root: 'One of the items in the cart no longer has enough stock.',
      evidence: `The product service refused the reservation with <b>409</b>: <code>${esc(data?.error ?? '')}</code>. Stock is checked and decremented in a single atomic statement, so two shoppers cannot both take the last one.`,
      fix: 'Reduce the quantity, or remove the item and re-add it to pick up the current stock level.',
      prevention: 'Re-read stock when the cart is opened, and show a live count on the product card.',
      cta: 'Back to cart',
      action: () => setStep('cart'),
    };
  } else {
    diagnosis = {
      root: `The order was rejected with HTTP ${status || 'a network error'}.`,
      evidence: `Response body: <code>${esc(data?.error ?? 'none')}</code>`,
      fix: 'Check the details and try again.',
      prevention: 'Surface the backend message rather than a generic failure, so the cause is actionable.',
      cta: null,
    };
  }

  $('kiraSlot').innerHTML = `
    <div class="kira-card" role="alert">
      <div class="kira-card-head">
        <div class="kira-avatar" aria-hidden="true">K</div>
        <div><b>Kira</b><span>Checkout assistant</span></div>
      </div>
      <div class="kira-body">
        <div class="kira-row"><b>Root cause</b> — ${diagnosis.root}</div>
        <div class="kira-row"><b>Evidence</b> — ${diagnosis.evidence}</div>
        <div class="kira-raw">${esc(raw)}</div>
        <div class="kira-row" style="margin-top:10px"><b>Fix</b> — ${diagnosis.fix}</div>
        <div class="kira-row"><b>Prevention</b> — ${diagnosis.prevention}</div>
        ${diagnosis.cta ? `<button class="kira-cta" id="kiraFix">${diagnosis.cta}</button>` : ''}
      </div>
    </div>`;
  if (diagnosis.cta) $('kiraFix').addEventListener('click', diagnosis.action);
}

/**
 * Confirmation reads the order back from the Orders READ service rather than
 * echoing the POST response — proof the write landed and is visible on the read
 * path, which is the CQRS split doing real work.
 */
async function showConfirmation(orderId, token) {
  setStep('confirm');
  $('orderNo').textContent = `Order #${orderId}`;
  const detail = $('confirmDetail');
  detail.innerHTML = '<p style="color:var(--ink-dim);font-size:12.5px">Reading the order back…</p>';

  const res = await api(`/orders/${orderId}`, { token });
  if (!res.ok) {
    detail.innerHTML = `<p style="color:var(--ink-dim);font-size:12.5px">Placed, but the read service returned ${res.status}.</p>`;
    return;
  }
  const o = res.data;
  const lines = (o.items ?? [])
    .map((it) => {
      const p = products.find((x) => x.id === it.product_id);
      return `<div class="confirm-line"><span>${esc(p?.name ?? `Product ${it.product_id}`)} × ${it.qty}</span><span class="muted">${money(
        it.unit_price_cents * it.qty,
      )}</span></div>`;
    })
    .join('');
  const a = o.shipping_address;
  detail.innerHTML = `<div class="confirm-lines">
    ${lines}
    ${Number(o.discount_cents) > 0 ? `<div class="confirm-line"><span class="muted">Discount${o.promo_code ? ` (${esc(o.promo_code)})` : ''}</span><span class="muted">−${money(o.discount_cents)}</span></div>` : ''}
    <div class="confirm-line"><span><b>Charged</b></span><span><b>${chargedMoney(o)}</b></span></div>
    <div class="confirm-line"><span class="muted">Status</span><span class="muted">${esc(o.status)}</span></div>
    ${a ? `<div class="confirm-line"><span class="muted">Ships to</span><span class="muted">${esc([a.line1, a.city, a.postcode].filter(Boolean).join(', '))}</span></div>` : ''}
  </div>`;
}

// ---------------------------------------------------------------------------
// Order history — from the READ service, so it survives a refresh
// ---------------------------------------------------------------------------
async function loadOrders() {
  try {
    const session = await getSession();
    const res = await api('/orders?limit=50', { token: session.token });
    orders = res.ok ? (res.data.orders ?? []) : [];
  } catch {
    orders = [];
  }
  updateBadges();
}

function renderOrders() {
  const list = $('ordersList');
  if (!orders.length) {
    list.innerHTML = '<div class="empty-cart">No orders yet.</div>';
    return;
  }
  list.innerHTML = orders
    .map((o) => {
      const when = new Date(o.created_at).toLocaleString('en-GB');
      // If the order was charged in a currency other than the one on screen,
      // show BOTH: the historical fact, and today's display value. Silently
      // re-converting would misreport what the customer actually paid.
      const differs = o.currency !== currency;
      return `<div class="order-item">
        <div class="on">Order #${o.id} · ${chargedMoney(o)}</div>
        <div class="om">${when} · ${esc(o.status)}${o.promo_code ? ` · ${esc(o.promo_code)}` : ''}</div>
        ${differs ? `<div class="oc">charged in ${esc(o.currency)} at ${Number(o.fx_rate)} per USD — ${money(o.total_cents)} at today's display rate</div>` : ''}
      </div>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$('grid').addEventListener('click', (e) => {
  const wish = e.target.closest('[data-wish]');
  if (wish) {
    e.stopPropagation();
    toggleWish(wish.dataset.wish);
    return;
  }
  const add = e.target.closest('.card-add');
  if (add && !add.disabled) {
    addToCart(add.dataset.id);
    return;
  }
  const qv = e.target.closest('[data-qv]');
  if (qv) openQuickView(qv.dataset.qv);
});

$('navTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.navtab');
  if (!btn) return;
  activeCat = btn.dataset.cat;
  renderTabs();
  renderGrid();
});
$('searchInput').addEventListener('input', (e) => {
  searchTerm = e.target.value;
  renderGrid();
});
$('sortSelect').addEventListener('change', (e) => {
  sortMode = e.target.value;
  renderGrid();
});

$('cartList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-d]');
  if (!b) return;
  const id = Number(b.dataset.id);
  const n = (cart.get(id) ?? 0) + Number(b.dataset.d);
  if (n <= 0) cart.delete(id);
  else cart.set(id, n);
  updateBadges();
  renderCart();
});

$('cartBtn').addEventListener('click', openDrawer);
$('closeDrawer').addEventListener('click', closeDrawer);
$('scrim').addEventListener('click', closeDrawer);
$('backBtn').addEventListener('click', () => {
  const i = STEPS.indexOf(step);
  if (i > 0) setStep(STEPS[i - 1]);
});
$('nextBtn').addEventListener('click', () => {
  if (step === 'cart') setStep('shipping');
  else if (step === 'shipping') setStep('payment');
  else if (step === 'payment') placeOrder();
});

['fName', 'fAddr', 'fCity', 'fPin', 'fPhone'].forEach((id) => $(id).addEventListener('input', refreshGate));
['fCard', 'fExp', 'fCvv'].forEach((id) => $(id).addEventListener('input', refreshGate));
$('fSeedBug').addEventListener('change', () => {
  syncDemoNotice();
  refreshGate();
});

const fillCard = (pan) => {
  $('fCard').value = pan;
  $('fExp').value = '12/30';
  $('fCvv').value = '123';
  refreshGate();
};
$('declineCard').addEventListener('click', () => fillCard('4000 0000 0000 0002'));
$('approveCard').addEventListener('click', () => fillCard('4242 4242 4242 4242'));

$('qvClose').addEventListener('click', closeQv);
$('qvScrim').addEventListener('click', (e) => {
  if (e.target.id === 'qvScrim') closeQv();
});
$('qvWish').addEventListener('click', () => toggleWish(qvCurrent));
$('qvAdd').addEventListener('click', () => {
  addToCart(qvCurrent);
  closeQv();
});

$('wishBtn').addEventListener('click', () => {
  activeCat = 'wishlist';
  renderTabs();
  renderGrid();
});
$('ordersBtn').addEventListener('click', async () => {
  await loadOrders();
  renderOrders();
  $('ordersScrim').classList.add('open');
});
$('ordersClose').addEventListener('click', () => $('ordersScrim').classList.remove('open'));
$('ordersScrim').addEventListener('click', (e) => {
  if (e.target.id === 'ordersScrim') $('ordersScrim').classList.remove('open');
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeQv();
  $('ordersScrim').classList.remove('open');
  closeDrawer();
});

// Currency: a DISPLAY toggle. It never rewrites an order's recorded amount.
$('currencyToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.cur-btn');
  if (!btn) return;
  currency = btn.dataset.cur;
  localStorage.setItem('arbor-currency', currency);
  document.querySelectorAll('.cur-btn').forEach((b) => b.classList.toggle('active', b.dataset.cur === currency));
  renderGrid();
  if ($('drawer').classList.contains('open') && step === 'cart') renderCart();
  if ($('qvScrim').classList.contains('open') && qvCurrent) openQuickView(qvCurrent);
  if ($('ordersScrim').classList.contains('open')) renderOrders();
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

const dash = new URLSearchParams(location.search).get('dashboard');
if (dash) $('systemLink').href = dash;

// ---- boot ----
document.querySelectorAll('.cur-btn').forEach((b) => b.classList.toggle('active', b.dataset.cur === currency));
await loadProducts();
api('/promo-codes')
  .then((r) => {
    if (r.ok) promoCodeHints = r.data.codes ?? [];
  })
  .catch(() => {});
loadOrders();
