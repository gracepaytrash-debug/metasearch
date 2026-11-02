import { expect, test } from "bun:test";
import {
  backoffDelay,
  isRetryable,
  RETRYABLE_STATUSES,
  retryAfterMs,
  withRetry,
  withTimeout,
} from "./resilient.js";

test("isRetryable: transient statuses", () => {
  for (const s of [408, 425, 429, 502, 503, 504]) {
    expect(isRetryable(Object.assign(new Error("x"), { status: s }))).toBe(
      true,
    );
  }
  expect(RETRYABLE_STATUSES.has(429)).toBe(true);
});

test("isRetryable: permanent errors are not retryable", () => {
  for (const s of [400, 401, 403, 404]) {
    expect(isRetryable(Object.assign(new Error("x"), { status: s }))).toBe(
      false,
    );
  }
  expect(isRetryable(new Error("bad request"))).toBe(false);
});

test("isRetryable: network errors and timeouts are retryable", () => {
  expect(isRetryable(new Error("fetch failed"))).toBe(true);
  expect(isRetryable(new Error("socket hang up"))).toBe(true);
  const t = new Error("slow");
  t.timeout = true;
  expect(isRetryable(t)).toBe(true);
});

test("withTimeout resolves fast promises", async () => {
  expect(await withTimeout(Promise.resolve(42), 1000, "t")).toBe(42);
});

test("withTimeout rejects slow promises with timeout flag", async () => {
  const slow = new Promise((r) => setTimeout(() => r(1), 200));
  const err = await withTimeout(slow, 30, "slow-op").catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err.timeout).toBe(true);
  expect(err.message).toContain("slow-op");
});

test("backoffDelay: full jitter within cap", () => {
  for (let i = 0; i < 50; i++) {
    const d0 = backoffDelay(0, 250, 2000);
    expect(d0).toBeGreaterThanOrEqual(0);
    expect(d0).toBeLessThanOrEqual(250);
    const d3 = backoffDelay(3, 250, 2000);
    expect(d3).toBeLessThanOrEqual(2000);
  }
  // jitter produces varied values
  const samples = new Set(
    Array.from({ length: 20 }, () => backoffDelay(1, 250, 2000).toFixed(2)),
  );
  expect(samples.size).toBeGreaterThan(1);
});

test("retryAfterMs parses seconds and HTTP dates", () => {
  expect(retryAfterMs(new Headers({ "retry-after": "5" }))).toBe(5000);
  expect(retryAfterMs(new Headers({ "retry-after": "0" }))).toBe(0);
  const future = new Date(Date.now() + 10000).toUTCString();
  const ms = retryAfterMs(new Headers({ "retry-after": future }));
  expect(ms).toBeGreaterThan(5000);
  expect(ms).toBeLessThanOrEqual(10000);
  expect(retryAfterMs(new Headers({}))).toBe(0);
  expect(retryAfterMs(null)).toBe(0);
});

test("withRetry succeeds immediately when fn works", async () => {
  let calls = 0;
  const out = await withRetry(async () => {
    calls++;
    return "ok";
  });
  expect(out).toBe("ok");
  expect(calls).toBe(1);
});

test("withRetry retries transient failures then succeeds", async () => {
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls++;
      if (calls < 3)
        throw Object.assign(new Error("bad gateway"), { status: 502 });
      return "recovered";
    },
    { retries: 3, baseDelay: 5, maxDelay: 20 },
  );
  expect(out).toBe("recovered");
  expect(calls).toBe(3);
});

test("withRetry does not retry permanent errors", async () => {
  let calls = 0;
  await expect(
    withRetry(
      async () => {
        calls++;
        throw Object.assign(new Error("bad"), { status: 400 });
      },
      { retries: 3, baseDelay: 5 },
    ),
  ).rejects.toThrow("bad");
  expect(calls).toBe(1);
});

test("withRetry exhausts retries and throws last error", async () => {
  let calls = 0;
  await expect(
    withRetry(
      async () => {
        calls++;
        throw Object.assign(new Error("down"), { status: 503 });
      },
      { retries: 2, baseDelay: 5, maxDelay: 10 },
    ),
  ).rejects.toThrow("down");
  expect(calls).toBe(3); // initial + 2 retries
});
