/**
 * In-flight request deduplication.
 *
 * When N requests for the same query are concurrent, only one upstream
 * fetch happens — everyone else shares the same promise. This protects the
 * Brave/Kagi quota and D1 write budget under burst traffic.
 *
 * Scope is deliberately narrow: entries are dropped as soon as the shared
 * promise settles. Sequential reuse is the edge cache's job (cache.js), not
 * this module's. Dropping on settle also keeps unit tests isolated without
 * any manual reset between cases.
 */

const inflight = new Map();

export function dedupKey(query, type, page, engines, extra = "") {
  const eng = [...(engines || [])].sort().join(",");
  return `${type}|p${page}|${eng}|${extra}|${query}`;
}

/**
 * Run `fn` unless an identical request is already in flight.
 * @returns the shared promise for this key
 */
export function deduplicated(key, fn) {
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = fn().finally(() => {
    // Only drop our own entry; a newer request for the same key may
    // already have replaced it.
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/** Test helper: drop all in-flight entries immediately. */
export function clearInflight() {
  inflight.clear();
}

/** Test helper: number of in-flight entries. */
export function inflightSize() {
  return inflight.size;
}
