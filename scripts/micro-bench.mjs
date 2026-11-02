#!/usr/bin/env bun
/**
 * Micro-benchmarks for the resilience modules.
 * Real numbers, no mocks of the modules themselves — measures actual
 * cache/dedup/breaker/runSearch behavior with a simulated upstream.
 *
 * Run: bun scripts/micro-bench.mjs
 */
import { mock } from "bun:test";

// ---- controllable mock upstream ----
let mode = "ok"; // ok | brave-fail
let upstreamCalls = 0;
mock.module("../src/search/mixed.js", () => ({
  default: async (query) => {
    upstreamCalls++;
    await new Promise((r) => setTimeout(r, 300)); // brave: 300ms scrape
    if (mode === "brave-fail") throw new Error("brave down");
    return {
      more_results_available: false,
      results: { web: { results: [{ title: `t-${query}`, url: `https://x/${query}` }] } },
    };
  },
}));
mock.module("../src/search/kagi.js", () => ({
  default: async (query) => {
    await new Promise((r) => setTimeout(r, 200)); // kagi: 200ms
    return {
      more_results_available: false,
      results: { web: { results: [{ title: `k-${query}`, url: `https://k/${query}` }] } },
    };
  },
}));

const { runSearch } = await import("../src/search/run.js");
const { getCached, setCached, clearMemoryCache } = await import("../src/search/cache.js");
const { deduplicated, clearInflight } = await import("../src/search/dedup.js");
const { CircuitBreaker, resetAllBreakers } = await import("../src/search/circuit-breaker.js");

const ms = (t0) => Number((performance.now() - t0).toFixed(2));
let q = 0;
const uq = (p) => `${p}-${++q}`;

console.log("\n📊 Micro-benchmarks (simulated upstream: brave 300ms, kagi 200ms)\n");

// 1. Cache: miss vs hit
{
  clearMemoryCache(); resetAllBreakers(); clearInflight(); mode = "ok";
  const query = uq("bench-cache");
  let t0 = performance.now();
  await runSearch({ query, engines: ["brave"], cache: true });
  const missMs = ms(t0);
  t0 = performance.now();
  const hit = await runSearch({ query, engines: ["brave"], cache: true });
  const hitMs = ms(t0);
  console.log(`1. cache miss: ${missMs}ms → hit: ${hitMs}ms  (${(missMs / Math.max(hitMs, 0.01)).toFixed(0)}× faster, from_cache=${hit.from_cache})`);
}

// 2. Dedup: 50 concurrent identical → 1 upstream call
{
  resetAllBreakers(); clearInflight(); upstreamCalls = 0; mode = "ok";
  const query = uq("bench-dedup");
  const t0 = performance.now();
  await Promise.all(Array.from({ length: 50 }, () => runSearch({ query, engines: ["brave"] })));
  const total = ms(t0);
  console.log(`2. dedup: 50 concurrent → ${upstreamCalls} upstream call(s) in ${total}ms (naive would be ${50 * 300}ms)`);
}

// 3. Circuit breaker: fail-fast when open
{
  const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 60000 });
  const fail = () => Promise.reject(new Error("down"));
  for (let i = 0; i < 3; i++) await cb.call(fail, () => "fb").catch(() => {});
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) await cb.call(fail, () => "fb");
  const fastMs = ms(t0);
  console.log(`3. circuit breaker: 1000 fail-fast fallbacks in ${fastMs}ms (${(fastMs / 1000).toFixed(3)}ms/op, upstream never touched)`);
}

// 4. Failover: brave fails after 300ms, kagi answers in 200ms
//    sequential = 300 (fail) + 200 (fallback) ≈ 500ms
//    parallel   = max(300, 200)              ≈ 300ms
{
  mode = "brave-fail";
  resetAllBreakers(); clearInflight();
  let t0 = performance.now();
  const seq = await runSearch({ query: uq("bench-seq"), engines: ["brave", "kagi"] });
  const seqMs = ms(t0);
  resetAllBreakers(); clearInflight();
  t0 = performance.now();
  const par = await runSearch({ query: uq("bench-par"), engines: ["brave", "kagi"], parallel: true });
  const parMs = ms(t0);
  mode = "ok";
  console.log(`4. failover — sequential: ${seqMs}ms (fallback_from=${seq.fallback_from}) → parallel: ${parMs}ms — ${((1 - parMs / seqMs) * 100).toFixed(0)}% latency cut`);
}

// 5. Cache primitive latency
{
  clearMemoryCache();
  const data = { results: { web: { results: [{ title: "x" }] } } };
  let t0 = performance.now();
  for (let i = 0; i < 1000; i++) await setCached(`k${i}`, "web", 0, data);
  const setMs = ms(t0);
  t0 = performance.now();
  for (let i = 0; i < 1000; i++) await getCached(`k${i}`, "web", 0);
  const getMs = ms(t0);
  console.log(`5. cache primitives: set=${(setMs / 1000).toFixed(3)}ms/op, get=${(getMs / 1000).toFixed(3)}ms/op (1000 ops)`);
}

// 6. Dedup primitive overhead
{
  clearInflight();
  const t0 = performance.now();
  for (let i = 0; i < 10000; i++) await deduplicated(`dk${i}`, async () => i);
  const total = ms(t0);
  console.log(`6. dedup primitive: ${(total / 10000).toFixed(4)}ms/op (10000 ops)`);
}

console.log("\n✅ done\n");
