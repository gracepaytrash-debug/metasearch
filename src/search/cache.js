/**
 * Edge cache for search results with stale-while-revalidate semantics.
 *
 * Strategy (matches Cloudflare's recommended caching pattern):
 * - Fresh (age < FRESH_TTL): serve instantly from cache, zero upstream cost.
 * - Stale (FRESH_TTL <= age < STALE_TTL): serve immediately, refresh in
 *   background via `ctx.waitUntil` when an execution context is available.
 * - Expired (age >= STALE_TTL): fetch fresh, replace the entry.
 *
 * Storage: Workers Cache API (`caches.default`) in production. In-memory
 * Map fallback when `caches` is unavailable (plain bun/node unit tests).
 * Failed searches are never cached.
 */

export const FRESH_TTL = 300; // 5 minutes — served instantly
export const STALE_TTL = 900; // 15 minutes — served stale + background refresh

const memoryStore = new Map(); // fallback for non-Workers runtimes

export function cacheKey(query, type, page) {
  return `https://search.internal/v1/${type}/p${page}?q=${encodeURIComponent(
    query,
  )}`;
}

function workersCache() {
  try {
    return typeof caches !== "undefined" && caches.default
      ? caches.default
      : null;
  } catch {
    return null;
  }
}

function toEntry(data) {
  return JSON.stringify({ cachedAt: Date.now(), data });
}

function fromEntry(text) {
  try {
    const parsed = JSON.parse(text);
    if (
      parsed &&
      typeof parsed.cachedAt === "number" &&
      parsed.data !== undefined
    ) {
      return parsed;
    }
  } catch {
    // corrupt entry -> treat as miss
  }
  return null;
}

function entryResponse(entry) {
  return new Response(toEntry(entry.data), {
    headers: {
      "content-type": "application/json",
      // Standard HTTP caching semantics so any layer (browser, CDN,
      // Workers Cache) understands the freshness windows.
      "cache-control": `public, max-age=${FRESH_TTL}, stale-while-revalidate=${
        STALE_TTL - FRESH_TTL
      }`,
      "x-cached-at": String(entry.cachedAt ?? Date.now()),
    },
  });
}

async function readEntry(key) {
  const cache = workersCache();
  if (cache) {
    const res = await cache.match(key);
    if (!res) return null;
    return fromEntry(await res.text());
  }
  const raw = memoryStore.get(key);
  return raw ? fromEntry(raw) : null;
}

async function writeEntry(key, data) {
  const body = toEntry(data);
  const cache = workersCache();
  if (cache) {
    await cache.put(
      key,
      new Response(body, {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${FRESH_TTL}, stale-while-revalidate=${
            STALE_TTL - FRESH_TTL
          }`,
        },
      }),
    );
    return;
  }
  memoryStore.set(key, body);
}

/**
 * Look up a cached search result.
 * @returns {{ data: any, stale: boolean } | null}
 */
export async function getCached(query, type, page) {
  const entry = await readEntry(cacheKey(query, type, page));
  if (!entry) return null;
  const age = Date.now() - entry.cachedAt;
  if (age >= STALE_TTL * 1000) return null; // expired -> full miss
  return { data: entry.data, stale: age >= FRESH_TTL * 1000 };
}

/**
 * Store a search result. Failures (search_error) are never cached.
 */
export async function setCached(query, type, page, data) {
  if (!data || data.search_error) return;
  await writeEntry(cacheKey(query, type, page), data);
}

/** Test helper: wipe the in-memory fallback store. */
export function clearMemoryCache() {
  memoryStore.clear();
}

export { entryResponse };
