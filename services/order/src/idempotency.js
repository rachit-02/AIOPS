/**
 * Idempotency for POST /orders (optional `Idempotency-Key` header).
 *
 * The storefront sends one key per checkout attempt. A request carrying a key
 * that already produced an order gets THAT order back instead of creating a
 * second one. A request that arrives while the first is still in flight waits
 * for it rather than racing it. Only successes are remembered: a decline or a
 * 409 releases the key, so the shopper can fix the card or the quantity and
 * retry with the same key.
 *
 * In-memory, per pod, for `ttlMs`. That is sufficient here because the order
 * service runs as a single replica; with more replicas (or across a pod
 * restart) this would need a unique column in order_svc.orders instead, which
 * needs a schema migration and was deliberately left out.
 */
export function createIdempotency({ ttlMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const slots = new Map(); // "userId:key" -> { expires, done: Promise<order | null> }

  function sweep(t) {
    for (const [slot, entry] of slots) if (entry.expires <= t) slots.delete(slot);
  }

  /**
   * Claim the slot for this request. `res` only needs `.on(event, fn)`.
   * Returns:
   *   { replay: order }  - this key already created an order; send it back
   *   { settle(order) }  - we own the slot; call settle(order) on success.
   *                        Any other outcome is settled as a failure when the
   *                        response finishes or the connection closes.
   *   null               - no usable key on the request
   */
  async function claim(userId, rawKey, res) {
    if (typeof rawKey !== 'string' || rawKey === '' || rawKey.length > 200) return null;
    const slot = `${userId}:${rawKey}`;
    sweep(now());

    // Loop: if the attempt we waited on failed, another waiter may have
    // claimed the slot before we resumed, so we wait on that one too.
    for (let prior = slots.get(slot); prior; prior = slots.get(slot)) {
      const created = await prior.done;
      if (created) return { replay: created };
    }

    let resolve;
    const entry = { expires: now() + ttlMs, done: new Promise((r) => (resolve = r)) };
    slots.set(slot, entry);
    let settled = false;
    const settle = (created) => {
      if (settled) return;
      settled = true;
      if (!created && slots.get(slot) === entry) slots.delete(slot);
      resolve(created ?? null);
    };
    res.on('finish', () => settle(null));
    res.on('close', () => settle(null));
    return { settle };
  }

  return { claim, size: () => slots.size };
}
