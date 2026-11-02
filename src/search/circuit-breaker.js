/**
 * Circuit breaker — fail fast when an upstream engine is down.
 *
 * States: CLOSED (traffic flows) -> OPEN (fail fast, no upstream calls) ->
 * HALF_OPEN (one probe request) -> CLOSED or back to OPEN.
 *
 * Improvements over a naive counter (per resilience research):
 * - Full jitter on the reset timeout so many isolates don't probe the
 *   recovering upstream at the exact same instant (thundering herd).
 * - One breaker per dependency (brave/kagi are independent).
 * - Permanent client errors (e.g. HTTP 400) don't trip the breaker —
 *   retrying those never helps.
 */

export const STATE = {
  CLOSED: "CLOSED",
  OPEN: "OPEN",
  HALF_OPEN: "HALF_OPEN",
};

export class CircuitBreaker {
  constructor({
    name = "default",
    failureThreshold = 5,
    resetTimeout = 30000,
    jitterRatio = 0.5,
  } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.resetTimeout = resetTimeout;
    this.jitterRatio = jitterRatio;
    this.state = STATE.CLOSED;
    this.failures = 0;
    this.openedAt = 0;
    this.halfOpenProbe = false;
  }

  /** Jittered cooldown: base * (1 - jitterRatio + rand * 2 * jitterRatio). */
  nextResetDelay() {
    const j = this.jitterRatio;
    return this.resetTimeout * (1 - j + Math.random() * 2 * j);
  }

  isOpen() {
    if (this.state !== STATE.OPEN) return false;
    if (Date.now() - this.openedAt >= this._cooldown) {
      this.state = STATE.HALF_OPEN;
      this.halfOpenProbe = false;
      return false;
    }
    return true;
  }

  /**
   * Run `fn` under the breaker. `fallback` runs instead of `fn` when the
   * circuit is open. Failures that are permanent client errors don't count.
   */
  async call(fn, fallback) {
    if (this.isOpen()) {
      return fallback();
    }

    // HALF_OPEN: only one probe at a time; the rest fail fast.
    if (this.state === STATE.HALF_OPEN) {
      if (this.halfOpenProbe) return fallback();
      this.halfOpenProbe = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (isPermanentError(err)) throw err; // don't count, don't swallow
      this.onFailure();
      throw err;
    }
  }

  onSuccess() {
    this.failures = 0;
    this.state = STATE.CLOSED;
    this.halfOpenProbe = false;
  }

  onFailure() {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.state = STATE.OPEN;
      this.openedAt = Date.now();
      this._cooldown = this.nextResetDelay();
      this.halfOpenProbe = false;
    } else if (this.state === STATE.HALF_OPEN) {
      // Probe failed -> straight back to OPEN with a fresh cooldown.
      this.state = STATE.OPEN;
      this.openedAt = Date.now();
      this._cooldown = this.nextResetDelay();
      this.halfOpenProbe = false;
    }
  }

  /** Test helper. */
  reset() {
    this.state = STATE.CLOSED;
    this.failures = 0;
    this.openedAt = 0;
    this.halfOpenProbe = false;
  }
}

/** Permanent client errors should neither trip the breaker nor be retried. */
export function isPermanentError(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    // 403/429 from Brave mean "blocked/rate-limited" — those are transient
    // for our purposes, so only 400/401/404 count as permanent here.
    return status === 400 || status === 401 || status === 404;
  }
  const msg = String(err?.message || "").toLowerCase();
  return (
    msg.includes("bad request") ||
    msg.includes("invalid query") ||
    msg.includes("not found")
  );
}

// ---- per-engine registry (one breaker per dependency) ----
const breakers = new Map();

export function getBreaker(name, options) {
  if (!breakers.has(name)) {
    breakers.set(name, new CircuitBreaker({ name, ...options }));
  }
  return breakers.get(name);
}

/** Test helper: reset every registered breaker. */
export function resetAllBreakers() {
  for (const b of breakers.values()) b.reset();
}
