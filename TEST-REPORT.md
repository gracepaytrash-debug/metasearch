# Metasearch Resilience Upgrade — Test Report

**Date:** 2026-11-02 · **Environment:** local `wrangler dev` (workerd) · **Scope:** resilience layer only (upstream Brave unreachable from sandbox — see §6)

## 1. What was built (Tier 1 of the improvement plan)

| Module | File | Purpose |
|---|---|---|
| Edge cache (SWR) | `src/search/cache.js` | Cache API + in-memory fallback; fresh 5 min, stale-while-revalidate 15 min; failures never cached |
| Request dedup | `src/search/dedup.js` | In-flight promise sharing per (query, type, page, engines); entries dropped on settle |
| Circuit breaker | `src/search/circuit-breaker.js` | Per-engine CLOSED→OPEN→HALF_OPEN, jittered cooldown, permanent 4xx don't trip |
| Retry/timeout primitives | `src/search/resilient.js` | `withTimeout`, `withRetry` (transient-only, full-jitter backoff, Retry-After) |
| Integration | `src/search/run.js` | Sequential fallback preserved; new opt-in `parallel` mode (Promise.allSettled + per-engine timeout + URL-dedup merge) |
| Wiring | `src/index.js` | `POST /api` now passes `cache: true` |

## 2. Unit tests — 67/67 pass

`bun test` — 10 files, 426 assertions, ~0.5s. Covers: cache hit/miss/stale/bypass/skipCache, dedup collapse + isolation, breaker trip/recover/jitter/permanent-error exclusion, retry classification/backoff/Retry-After, runSearch integration (sequential, parallel merge, parallel timeout, breaker interaction).

## 3. Lint

`biome check` clean on all new/changed files. 4 remaining diagnostics are pre-existing in upstream `src/search/kagibot/` (fixtures + parser) — intentionally untouched.

## 4. Live resilience benchmark (`scripts/bench-resilience.mjs`) — all expectations met

| Check | Result |
|---|---|
| Dedup: 10 concurrent identical requests | wall **383 ms**; all `took` = 302 ms (**stdev 0.0 ms**) → single shared upstream call ✅ |
| Circuit breaker: 8 sequential failing requests | pre-trip p50 **256 ms** → post-trip p95 **0 ms**; trips exactly after 5th failure; error `"brave: brave circuit open — skipped"` ✅ |
| Cache contract | failed searches served with `from_cache` unset on both 1st and 2nd request → no cache poisoning ✅ |
| Graceful degradation | 502 + structured `search_error`, never a 500 crash ✅ |

## 5. E2E suite (`scripts/e2e-test.mjs`) — 16/16 pass

- **Functional:** homepage 200 + HTML; `/api` contract (echoes query/type/page, `engine` string, `took` number); graceful 502 on upstream failure.
- **Invalid inputs:** missing query → 400, bad type → 400, negative page → 400, bad engine → 400, malformed JSON → 400, unknown route → 404.
- **Load (autocannon, homepage, 10 conn × 15 s):** **122.6 rps**, p50 **80 ms**, p99 **229 ms**, max 277 ms, 0 errors, 0 timeouts, 0 non-2xx.
- **Rate limit:** 60 requests served, first **429 at request #62** — matches `API_LIMIT = 60/min` in `wrangler.toml` exactly.

## 6. Honest limitations (sandbox)

- Brave/Kagi upstreams are unreachable from this sandbox, so **cache-hit latency for successful searches could not be measured live** — only the failure path (correctly: not cached). In production, repeat queries should serve from edge cache in ~0–5 ms vs ~250+ ms upstream.
- Breaker recovery (HALF_OPEN → CLOSED on real success) verified in unit tests only, for the same reason.
- Load numbers are single-machine `workerd`; production edge will differ.

## 7. Method references

- Cloudflare Workers Cache (2026): `Cache-Control: public, max-age + stale-while-revalidate`, `Cf-Cache-Status` verification, per-worker opt-in.
- Resilience: exponential backoff with full jitter, retry transient-only (429/5xx/network), honor `Retry-After`, one breaker per dependency, jittered probe to avoid thundering herd.
- Load methodology: k6/autocannon percentile-based (p50/p95/p99, not averages), pre-declared thresholds, arrival-rate thinking, generator-side validation (0 dropped).

## 8. Recommendations (not yet done)

- Tier 2: `Promise.allSettled` partial-result streaming is implemented in `run.js` (`parallel` mode) but not yet wired to `/api` — needs product decision on merge UX.
- Consider requiring N consecutive successes to close from HALF_OPEN (currently 1).
- CI: add GitHub Actions (biome → bun test → deploy) — config drafted in analysis, not applied.
- Production: verify `from_cache` hit rate and p95 via Analytics Engine (1M events/day free).
