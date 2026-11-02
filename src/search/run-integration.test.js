/**
 * Integration tests for runSearch with mocked engines.
 *
 * Mocking rules learned the hard way (bun:test):
 * - mock.module() must run at top level BEFORE importing run.js.
 * - Use a unique query per request to avoid cache/dedup cross-talk,
 *   except in tests that specifically assert caching behaviour.
 */
import { beforeEach, expect, mock, test } from "bun:test";

let mixedCalls = 0;
let kagiCalls = 0;
let lastOpts = null;
let behavior = "ok"; // ok | fail | slow

mock.module("./mixed.js", () => ({
  default: async (query, _page, opts) => {
    mixedCalls++;
    lastOpts = opts;
    if (behavior === "fail") throw new Error("upstream down");
    if (behavior === "slow") await new Promise((r) => setTimeout(r, 5000));
    return {
      more_results_available: false,
      results: {
        web: { results: [{ title: `b-${query}`, url: `https://b/${query}` }] },
      },
    };
  },
}));

mock.module("./kagi.js", () => ({
  default: async (query) => {
    kagiCalls++;
    return {
      more_results_available: false,
      results: {
        web: { results: [{ title: `k-${query}`, url: `https://k/${query}` }] },
      },
    };
  },
}));

const { runSearch } = await import("./run.js");
const { resetAllBreakers } = await import("./circuit-breaker.js");
const { clearMemoryCache } = await import("./cache.js");
const { clearInflight } = await import("./dedup.js");

let n = 0;
const uq = (p = "q") => `${p}${++n}`;

beforeEach(() => {
  mixedCalls = 0;
  kagiCalls = 0;
  lastOpts = null;
  behavior = "ok";
  resetAllBreakers();
  clearMemoryCache();
  clearInflight();
});

// ---------- sequential (original behaviour preserved) ----------

test("sequential: returns brave results", async () => {
  const out = await runSearch({ query: uq(), engines: ["brave"] });
  expect(out.engine).toBe("brave");
  expect(out.results.web.results).toHaveLength(1);
  expect(out.results.web.results[0].title).toStartWith("b-");
  expect(mixedCalls).toBe(1);
  expect(out.from_cache).toBeUndefined();
});

test("sequential: failure produces search_error, not a throw", async () => {
  behavior = "fail";
  const out = await runSearch({ query: uq(), engines: ["brave"] });
  expect(out.search_error).toContain("upstream down");
  expect(out.engine).toBe("brave");
});

test("parameters: safe/time filters forwarded, invalid dropped", async () => {
  await runSearch({
    query: uq(),
    engines: ["brave"],
    safe: "strict",
    time: "pw",
  });
  expect(lastOpts.safe).toBe("strict");
  expect(lastOpts.time).toBe("pw");
  await runSearch({
    query: uq(),
    engines: ["brave"],
    safe: "bogus",
    time: "nope",
  });
  expect(lastOpts.safe).toBeUndefined();
  expect(lastOpts.time).toBeUndefined();
});

// ---------- edge cache ----------

test("cache: miss then hit, second is instant", async () => {
  const q = uq("cache");
  const first = await runSearch({ query: q, engines: ["brave"], cache: true });
  expect(first.from_cache).toBeUndefined();
  expect(mixedCalls).toBe(1);

  const second = await runSearch({ query: q, engines: ["brave"], cache: true });
  expect(second.from_cache).toBe(true);
  expect(second.results.web.results[0].title).toBe(
    first.results.web.results[0].title,
  );
  expect(mixedCalls).toBe(1); // no new upstream call
});

test("cache: failures are never cached", async () => {
  behavior = "fail";
  const q = uq("failcache");
  const f1 = await runSearch({ query: q, engines: ["brave"], cache: true });
  expect(f1.search_error).toContain("upstream down");
  const f2 = await runSearch({ query: q, engines: ["brave"], cache: true });
  expect(f2.search_error).toContain("upstream down");
  expect(mixedCalls).toBe(2);
});

test("cache: skipCache forces a fresh fetch", async () => {
  const q = uq("skip");
  await runSearch({ query: q, engines: ["brave"], cache: true });
  const s2 = await runSearch({
    query: q,
    engines: ["brave"],
    cache: true,
    skipCache: true,
  });
  expect(s2.from_cache).toBeUndefined();
  expect(mixedCalls).toBe(2);
});

test("cache bypass: page>0 is never cached", async () => {
  const q = uq("page");
  await runSearch({ query: q, engines: ["brave"], cache: true, page: 1 });
  await runSearch({ query: q, engines: ["brave"], cache: true, page: 1 });
  expect(mixedCalls).toBe(2);
});

// ---------- dedup ----------

test("dedup: concurrent identical requests collapse to one upstream call", async () => {
  const q = uq("dedup");
  const results = await Promise.all([
    runSearch({ query: q, engines: ["brave"] }),
    runSearch({ query: q, engines: ["brave"] }),
    runSearch({ query: q, engines: ["brave"] }),
  ]);
  expect(mixedCalls).toBe(1);
  expect(results[0].results.web.results[0].title).toBe(
    results[1].results.web.results[0].title,
  );
});

test("dedup: sequential requests re-execute (cache's job, not dedup's)", async () => {
  const q = uq("seq");
  await runSearch({ query: q, engines: ["brave"] });
  await runSearch({ query: q, engines: ["brave"] });
  expect(mixedCalls).toBe(2);
});

// ---------- parallel ----------

test("parallel: races engines and merges winners", async () => {
  const out = await runSearch({
    query: uq("par"),
    engines: ["brave", "kagi"],
    parallel: true,
  });
  expect(mixedCalls).toBe(1);
  expect(kagiCalls).toBe(1);
  expect(out.merged_from).toEqual(["brave", "kagi"]);
  // web results merged, deduped by URL
  expect(out.results.web.results).toHaveLength(2);
});

test("parallel: slow engine times out, fast engine wins", async () => {
  behavior = "slow";
  const out = await runSearch({
    query: uq("timeout"),
    engines: ["brave", "kagi"],
    parallel: true,
    engineTimeout: 150,
  });
  expect(out.engine).toBe("kagi");
  expect(out.results.web.results[0].title).toStartWith("k-");
  expect(out.search_error).toBeUndefined();
}, 10000);

// ---------- circuit breaker ----------

test("circuit breaker: opens after threshold, then fails fast", async () => {
  behavior = "fail";
  for (let i = 0; i < 5; i++) {
    await runSearch({ query: uq("cb"), engines: ["brave"] });
  }
  expect(mixedCalls).toBe(5);

  // 6th request: circuit open -> upstream NOT called again
  const out = await runSearch({ query: uq("cb"), engines: ["brave"] });
  expect(mixedCalls).toBe(5);
  expect(out.search_error).toContain("circuit open");
});

test("circuit breaker: does not trip on intermittent success", async () => {
  behavior = "fail";
  await runSearch({ query: uq("flap"), engines: ["brave"] });
  await runSearch({ query: uq("flap"), engines: ["brave"] });
  behavior = "ok";
  const out = await runSearch({ query: uq("flap"), engines: ["brave"] });
  expect(out.search_error).toBeUndefined();
  expect(mixedCalls).toBe(3);
});
