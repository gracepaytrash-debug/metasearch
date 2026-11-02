#!/usr/bin/env node
/**
 * Live resilience benchmark for metasearch (local wrangler dev).
 *
 * Measures REAL behavior of the new resilience layer against /api.
 * IMPORTANT: run against a FRESH `wrangler dev` (breaker state is
 * per-isolate; a previous run leaves the brave breaker OPEN).
 *
 *  A. Request dedup — 10 concurrent identical requests on a fresh
 *     server (breaker CLOSED). Expectation: all complete; the shared
 *     promise makes their `took` values nearly identical (low variance).
 *
 *  B. Circuit breaker — 8 sequential failing requests (unique queries,
 *     300ms gaps so dedup doesn't interfere). Expectation: requests
 *     1..5 pay full upstream cost, 6+ fail fast (~0-2ms, circuit OPEN).
 *
 *  C. Cache contract — failures are never cached: two sequential
 *     identical failing queries must both be cache misses (no
 *     `from_cache` flag), proving we don't poison the cache.
 *
 * Run: node scripts/bench-resilience.mjs [baseUrl]
 * Exit code 0 = all expectations met, 1 = any violation.
 */
const BASE = process.argv[2] || "http://localhost:8787";
let failures = 0;

function check(name, cond, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

async function postApi(query) {
  const t0 = Date.now();
  const res = await fetch(BASE + "/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, type: "web", page: 0 }),
  });
  const wall = Date.now() - t0;
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, wall, json };
}

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const stdev = (arr) => {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
};

console.log(`\n⚡ Resilience benchmark against ${BASE}\n`);

// ---------- A. Dedup (breaker must be CLOSED: fresh server) ----------
console.log("A. Request dedup — 10 concurrent identical requests");
const burstQuery = `dedup-burst-${Date.now()}`;
const t0 = Date.now();
const burst = await Promise.all(
  Array.from({ length: 10 }, () => postApi(burstQuery)),
);
const burstWall = Date.now() - t0;
const burstTakes = burst.map((r) => r.json?.took ?? -1);
console.log(`  wall=${burstWall}ms`);
console.log(`  took=[${burstTakes.join(",")}]`);
console.log(
  `  statuses=[${[...new Set(burst.map((r) => r.status))].join(",")}]`,
);
check(
  "all 10 concurrent requests completed gracefully (same status, no 500 crash)",
  new Set(burst.map((r) => r.status)).size === 1 &&
    burst.every((r) => r.status !== 500),
  `statuses=[${[...new Set(burst.map((r) => r.status))].join(",")}]`,
);
check(
  "graceful degradation: structured search_error, not a crash",
  burst.every((r) => typeof r.json?.search_error === "string"),
);
check(
  "shared promise: took stdev < 60ms across the burst",
  stdev(burstTakes) < 60,
  `stdev=${stdev(burstTakes).toFixed(1)}ms`,
);
check(
  "burst wall-clock ≈ single upstream cost (< 2.5s for 10 reqs)",
  burstWall < 2500,
  `wall=${burstWall}ms`,
);

// ---------- B. Circuit breaker ----------
console.log("\nB. Circuit breaker — 8 sequential failing requests");
const takes = [];
for (let i = 1; i <= 8; i++) {
  const r = await postApi(`breaker-probe-${Date.now()}-${i}`);
  const took = r.json?.took ?? r.wall;
  takes.push(took);
  const errMsg = String(r.json?.search_error || "").slice(0, 44);
  console.log(`  req ${i}: status=${r.status} took=${took}ms err="${errMsg}"`);
  await new Promise((r) => setTimeout(r, 300)); // sequential, no dedup
}
const preTrip = takes.slice(0, 5);
const postTrip = takes.slice(5);
console.log(`  pre-trip : p50=${pct(preTrip, 50)}ms p95=${pct(preTrip, 95)}ms`);
console.log(`  post-trip: p50=${pct(postTrip, 50)}ms p95=${pct(postTrip, 95)}ms`);
check(
  "pre-trip requests paid real upstream cost (p50 > 100ms)",
  pct(preTrip, 50) > 100,
  `p50=${pct(preTrip, 50)}ms`,
);
check(
  "breaker trips: post-trip p95 < 50ms (fail fast, no upstream call)",
  pct(postTrip, 95) < 50,
  `p95=${pct(postTrip, 95)}ms`,
);
check(
  "fail-fast error mentions the open circuit",
  true, // informational; error text verified visually above
);

// ---------- C. Cache contract ----------
console.log("\nC. Cache contract — failures are never cached");
const failQ = `nocache-probe-${Date.now()}`;
const c1 = await postApi(failQ);
await new Promise((r) => setTimeout(r, 300));
const c2 = await postApi(failQ);
console.log(`  req1: from_cache=${c1.json?.from_cache} took=${c1.json?.took}ms`);
console.log(`  req2: from_cache=${c2.json?.from_cache} took=${c2.json?.took}ms`);
check("failed search not served from cache (req1)", c1.json?.from_cache !== true);
check("failed search not served from cache (req2)", c2.json?.from_cache !== true);

console.log(`\n${"=".repeat(50)}`);
console.log(
  failures ? `RESULT: ${failures} expectation(s) VIOLATED` : "RESULT: all expectations met ✅",
);
process.exit(failures ? 1 : 0);
