/**
 * Checkout end-to-end regression tests.
 *
 * These drive a REAL browser against a REAL running stack and assert on the
 * actual request the page put on the wire and the actual status the order
 * service answered with. Nothing here imports a validation function.
 *
 * WHY IT IS WRITTEN THIS WAY
 * The bug these tests exist for could not have been caught by unit-testing the
 * validators, because every validator was individually correct. The gate
 * validated the DOM; placeOrder() serialised the DOM separately. Two readings
 * of the same fields through two code paths, free to disagree — and with the
 * demo switch on they did: five green "✓ looks good" ticks, an enabled button,
 * and a payload with no shippingAddress key at all, so the server answered
 * 400 shippingAddress required.
 *
 * The invariant that was violated is therefore the invariant under test:
 *
 *   IF the UI lets you press "Place order", THEN the payload it sends must
 *   satisfy the same address contract the order service enforces — unless the
 *   demo switch is on, in which case the UI must SAY SO on screen.
 *
 * That is asserted against an intercepted payload and a real HTTP status, so a
 * future refactor that reintroduces a second serialisation path fails here.
 *
 * RUNNING
 *   docker compose up -d                       # or point at the cluster
 *   npm test --prefix services/frontend
 *   BASE=http://localhost:8090 npm test --prefix services/frontend
 *
 * The suite FAILS, loudly, when the stack is unreachable. It does not skip. A
 * test that silently passes because it tested nothing is the exact failure
 * mode this project keeps running into.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8087';

// The three fields services/order/src/index.js -> validateShipTo() requires.
// Kept as data so the assertion below reads as the contract, not as a lookup.
const REQUIRED_ADDRESS_FIELDS = ['line1', 'city', 'postcode'];

const ADDRESS = {
  fName: 'Rachit Shrivastava',
  fAddr: '12 Mill Lane',
  fCity: 'Pune',
  fPin: '411001',
  fPhone: '9876543210',
};

let browser;

before(async () => {
  const res = await fetch(`${BASE}/api/products`).catch((err) => {
    throw new Error(`stack unreachable at ${BASE} (${err.message}). Start it with \`docker compose up -d\` or set BASE.`);
  });
  assert.equal(res.status, 200, `${BASE}/api/products should serve the catalogue`);
  const products = await res.json();
  assert.ok(products.length > 0, 'the catalogue must not be empty - is the DB seeded?');
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

/**
 * Drive a checkout to the point of submission and capture what really happened.
 * Returns the intercepted request body and the real response status.
 */
async function checkout({ fillAddress = true, tickDemoSwitch = false, card = 'approve' } = {}) {
  const page = await browser.newPage();
  const captured = { payload: null, status: null };

  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/orders') {
      captured.payload = JSON.parse(req.postData() ?? 'null');
    }
  });
  page.on('response', async (res) => {
    if (res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/orders') {
      captured.status = res.status();
      captured.body = await res.json().catch(() => null);
    }
  });

  await page.goto(BASE);
  await page.waitForSelector('.card-add:not([disabled])');
  await page.locator('.card-add:not([disabled])').first().click();
  await page.waitForSelector('#drawer.open');
  await page.click('#nextBtn'); // cart -> shipping

  // Order matters: ticking the switch disables the address inputs, so a test
  // that ticked first could not type at all. Fill, then tick, which is also
  // the sequence a person follows.
  if (fillAddress) {
    for (const [id, value] of Object.entries(ADDRESS)) await page.fill(`#${id}`, value);
  }
  if (tickDemoSwitch) await page.check('#fSeedBug');

  const ui = {
    continueEnabled: !(await page.locator('#nextBtn').isDisabled()),
    greenHints: await page.locator('.field-hint.ok').count(),
    shipNoticeVisible: await page.locator('#shipNotice').isVisible(),
    addressInputsDisabled: await page.locator('#fAddr').isDisabled(),
  };
  if (!ui.continueEnabled) {
    await page.close();
    return { ...captured, ui, reachedPayment: false };
  }

  await page.click('#nextBtn'); // shipping -> payment
  ui.payNoticeVisible = await page.locator('#payNotice').isVisible();
  await page.click(card === 'decline' ? '#declineCard' : '#approveCard');

  const placeEnabled = !(await page.locator('#nextBtn').isDisabled());
  if (!placeEnabled) {
    await page.close();
    return { ...captured, ui, reachedPayment: true, placeEnabled: false };
  }

  await page.click('#nextBtn'); // place order
  await page.waitForFunction(
    () => document.querySelector('.kira-raw') || document.querySelector('#orderNo')?.textContent,
    null,
    { timeout: 20000 },
  );

  const orderNo = await page.locator('#orderNo').textContent().catch(() => '');
  const kiraRaw = await page.locator('.kira-raw').first().textContent().catch(() => null);
  const storageKey = await page.evaluate(() => localStorage.getItem('arbor-session'));
  await page.close();
  return { ...captured, ui, reachedPayment: true, placeEnabled: true, orderNo, kiraRaw, storageKey };
}

describe('checkout submits what the form collected', () => {
  test('REGRESSION: a completed form reaches the server WITH its address', async () => {
    const r = await checkout();

    assert.ok(r.payload, 'the page must actually POST /api/orders - no request was captured');
    // The assertion that would have failed before the fix.
    assert.ok(
      r.payload.shippingAddress,
      `payload reached the server with no shippingAddress key at all: ${JSON.stringify(r.payload)}`,
    );
    for (const field of REQUIRED_ADDRESS_FIELDS) {
      assert.ok(
        typeof r.payload.shippingAddress[field] === 'string' && r.payload.shippingAddress[field].trim() !== '',
        `shippingAddress.${field} is required by the order service but was ${JSON.stringify(r.payload.shippingAddress[field])}`,
      );
    }
    // Field-to-payload mapping, which is where a renamed input would break it.
    assert.equal(r.payload.shippingAddress.line1, ADDRESS.fAddr, '#fAddr must serialise to line1');
    assert.equal(r.payload.shippingAddress.city, ADDRESS.fCity, '#fCity must serialise to city');
    assert.equal(r.payload.shippingAddress.postcode, ADDRESS.fPin, '#fPin must serialise to postcode');

    // And the server really accepted it.
    assert.equal(r.status, 201, `expected a real 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.match(r.orderNo, /Order #\d+/, 'the confirmation must read back a real order id');
  });

  test('THE INVARIANT: an enabled submit button implies a server-acceptable payload', async () => {
    // This is the general form of the bug: the gate said yes, the payload was
    // rejected. Whatever the UI state, those two must agree.
    const r = await checkout();
    assert.equal(r.placeEnabled, true, 'a fully completed form must reach an enabled "Place order"');
    assert.notEqual(
      r.status,
      400,
      `the UI enabled submission for a payload the server rejected as malformed: ${JSON.stringify(r.body)}`,
    );
  });

  test('an incomplete form cannot reach submission at all', async () => {
    const r = await checkout({ fillAddress: false });
    assert.equal(r.ui.continueEnabled, false, 'an empty shipping form must not enable Continue');
    assert.equal(r.payload, null, 'nothing may be POSTed from an incomplete form');
  });
});

describe('the demo switch is honest about what it sends', () => {
  test('it announces itself instead of silently dropping a filled-in address', async () => {
    const r = await checkout({ tickDemoSwitch: true });

    // It still sends the address-less request - that is the whole point, it is
    // how the seeded backend bug gets exercised.
    assert.ok(r.payload, 'the demo path must still POST a real request');
    assert.equal(
      r.payload.shippingAddress,
      undefined,
      'the demo switch must omit shippingAddress entirely, as a buggy client would',
    );

    // ...but the UI must SAY so. These are the assertions that make the
    // original report impossible: no silent contradiction between a form full
    // of green ticks and a payload carrying none of it.
    assert.equal(r.ui.shipNoticeVisible, true, 'the shipping step must warn that no address will be sent');
    assert.equal(r.ui.payNoticeVisible, true, 'the payment step must repeat the warning where "Place order" lives');
    assert.equal(r.ui.addressInputsDisabled, true, 'address inputs must be disabled when they cannot affect the request');
    assert.equal(r.ui.greenHints, 0, 'no field may show "looks good" when its value is about to be discarded');

    // The response is whatever the backend genuinely returned: 400 with the
    // seeded bug disarmed, 500 with it armed. Both are real; neither is scripted.
    assert.ok([400, 500].includes(r.status), `expected a real 400 or 500 from the order service, got ${r.status}`);
    assert.ok(r.kiraRaw?.includes(`HTTP ${r.status}`), 'the assistant must print the verbatim backend response');
  });
});

describe('payment decline is a real backend refusal', () => {
  test('the decline test card produces a genuine 402, not a client-side check', async () => {
    const r = await checkout({ card: 'decline' });
    assert.equal(r.placeEnabled, true, 'the decline card must pass client validation, or the 402 is unreachable');
    assert.equal(r.status, 402, `expected a real 402 from the order service, got ${r.status}`);
    assert.equal(r.body?.decline_code, 'generic_decline');
    assert.ok(r.kiraRaw?.includes('HTTP 402'), 'the assistant must show the verbatim 402 body');
  });
});

describe('order history survives a reload', () => {
  test('a placed order is still listed after the page is reloaded', async () => {
    // Placed and read back in one browser context, with a full reload between,
    // so this exercises the stored session + the Orders READ service rather
    // than in-memory state.
    const page = await browser.newPage();
    await page.goto(BASE);
    await page.waitForSelector('.card-add:not([disabled])');
    await page.locator('.card-add:not([disabled])').first().click();
    await page.waitForSelector('#drawer.open');
    await page.click('#nextBtn');
    for (const [id, value] of Object.entries(ADDRESS)) await page.fill(`#${id}`, value);
    await page.click('#nextBtn');
    await page.click('#approveCard');
    await page.click('#nextBtn');
    await page.waitForSelector('#orderNo', { timeout: 20000 });
    const placed = (await page.textContent('#orderNo'))?.match(/#(\d+)/)?.[1];
    assert.ok(placed, 'an order id is required for this test to mean anything');

    await page.reload();
    await page.waitForSelector('.card-add');
    await page.click('#ordersBtn');
    await page.waitForSelector('#ordersList .order-item', { timeout: 20000 });
    const history = await page.textContent('#ordersList');
    assert.match(
      history,
      new RegExp(`Order #${placed}\\b`),
      `order #${placed} must still be listed after a reload - history comes from the Orders read service, not memory`,
    );
    await page.close();
  });
});
