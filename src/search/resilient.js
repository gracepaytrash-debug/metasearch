/**
 * Resilience primitives: timeouts, retryable-error classification,
 * exponential backoff with full jitter, and Retry-After support.
 *
 * Rules (from production resilience research):
 * - Retry ONLY transient failures: network errors, 429, 502, 503, 504.
 *   Never retry 400/401/404 — the request itself is wrong.
 * - Always add jitter: `random(0, base * 2^attempt)` prevents the
 *   thundering herd when the upstream recovers.
 * - Honor the server's `Retry-After` header when present.
 * - Keep retries few and delays small: Workers have a 10ms CPU budget
 *   per request on the free tier; sleeping doesn't burn CPU but every
 *   millisecond is user-visible latency.
 */

export const RETRYABLE_STATUSES = new Set([408, 425, 429, 502, 503, 504]);

export function statusOf(err) {
  return err?.status ?? err?.response?.status ?? null;
}

/** True when retrying could plausibly succeed. */
export function isRetryable(err) {
  if (!err) return false;
  if (err.timeout) return true; // our own timeout -> transient
  const status = statusOf(err);
  if (status !== null) return RETRYABLE_STATUSES.has(status);
  const msg = String(err?.message || "").toLowerCase();
  // Network-level failures have no status but are transient.
  return (
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("socket") ||
    msg.includes("temporarily")
  );
}

/**
 * Race a promise against a timeout. The timeout error carries
 * `{ timeout: true }` so callers can classify it.
 */
export function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.timeout = true;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Full-jitter exponential backoff: random(0, min(base * 2^attempt, max)).
 * Attempt is 0-based (first retry).
 */
export function backoffDelay(attempt, base = 250, max = 2000) {
  const cap = Math.min(base * 2 ** attempt, max);
  return Math.random() * cap;
}

/** Parse `Retry-After` (seconds or HTTP date) into milliseconds. */
export function retryAfterMs(headers) {
  if (!headers) return 0;
  const raw =
    typeof headers.get === "function"
      ? headers.get("retry-after")
      : headers["retry-after"];
  if (!raw) return 0;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` with bounded retries for transient failures only.
 *
 * @param {() => Promise<any>} fn
 * @param {{ retries?: number, baseDelay?: number, maxDelay?: number,
 *           getRetryAfter?: (err) => number }} opts
 */
export async function withRetry(fn, opts = {}) {
  const { retries = 1, baseDelay = 250, maxDelay = 2000, getRetryAfter } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < retries && isRetryable(err);
      if (!canRetry) throw err;
      const serverHint = getRetryAfter ? getRetryAfter(err) : 0;
      const delay = Math.min(
        Math.max(backoffDelay(attempt, baseDelay, maxDelay), serverHint),
        maxDelay * 2,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}
