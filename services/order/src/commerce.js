/**
 * Commerce rules that MUST run server-side.
 *
 * Promo codes and the payment decision both live here rather than in the
 * storefront, for the same reason product prices do: anything the browser can
 * edit is not a rule, it is a suggestion. A client that posted its own
 * discounted total, or decided for itself that a card was approved, would make
 * both features decorative.
 */

/**
 * Promo codes, with their discount as a fraction of subtotal.
 *
 * Deliberately a server-side table. The storefront sends only the CODE; the
 * amount is computed here from prices the product service supplied. Sending a
 * pre-discounted total from the browser would let anyone buy anything for a
 * penny, which is exactly the property `POST /products/reserve` exists to
 * protect.
 */
const PROMO_CODES = {
  WELCOME10: { rate: 0.1, label: '10% off your first order' },
  SHIP5: { rate: 0.05, label: '5% off' },
};

/** Fixed demo rates: units of the target currency per 1 USD. */
const FX_RATES = { USD: 1, INR: 83 };

/**
 * A deliberately fixed rate rather than a live FX API.
 *
 * A real integration would need a rate provider, caching, a stale-rate policy
 * and a story for what happens when the provider is down mid-checkout — none of
 * which this project is about. What DOES matter, and is implemented properly,
 * is that whatever rate was used gets stored on the order, so a later display
 * toggle cannot rewrite what the customer was charged.
 */
export function fxRate(currency) {
  return FX_RATES[currency] ?? null;
}

export function isSupportedCurrency(currency) {
  return Object.prototype.hasOwnProperty.call(FX_RATES, currency);
}

/**
 * Validate a promo code and compute the discount in USD cents.
 * Returns { code, discountCents, label } or null when there is no valid code.
 */
export function applyPromo(rawCode, subtotalCents) {
  if (!rawCode) return null;
  const code = String(rawCode).trim().toUpperCase();
  const promo = PROMO_CODES[code];
  if (!promo) return null;
  // Floor, so rounding can never produce a discount larger than the subtotal.
  const discountCents = Math.min(subtotalCents, Math.floor(subtotalCents * promo.rate));
  return { code, discountCents, label: promo.label };
}

/** Public list, so the storefront can hint at valid codes without hardcoding them. */
export const promoCodeNames = Object.keys(PROMO_CODES);

// ---------------------------------------------------------------------------
// Payment (demo)
// ---------------------------------------------------------------------------

/**
 * Standard test PANs. These are the well-known values every payment provider
 * reserves for testing; they are not real cards and cannot move money.
 */
const DECLINE_CARDS = new Set(['4000000000000002']);
const APPROVE_CARDS = new Set(['4242424242424242']);

/**
 * Decide a payment.
 *
 * This is a DEMO gate, not a payment integration — there is no acquirer and no
 * money moves. It lives on the server anyway, because the point of the decline
 * path is that the storefront renders a real backend failure rather than a
 * scripted one. A browser-side `if (card === decline)` would look identical on
 * screen while proving nothing.
 *
 * SECURITY: the PAN is used for this comparison and then discarded. It is never
 * persisted, never logged, and only the last four digits leave this function —
 * a real integration would tokenise before the number ever reached a service.
 */
export function authorizePayment(rawCard) {
  const pan = String(rawCard ?? '').replace(/[\s-]/g, '');
  const last4 = pan.slice(-4);

  if (!/^[0-9]{13,19}$/.test(pan)) {
    return { ok: false, code: 'invalid_card_number', message: 'Card number must be 13-19 digits.', last4 };
  }
  if (DECLINE_CARDS.has(pan)) {
    return {
      ok: false,
      code: 'generic_decline',
      message: 'The card issuer declined the charge.',
      last4,
    };
  }
  if (APPROVE_CARDS.has(pan)) return { ok: true, last4 };

  // Anything else: accept, so the demo is not limited to two magic numbers,
  // but say plainly that nothing was authorised for real.
  return { ok: true, last4, note: 'demo mode: no real authorization performed' };
}
