import { beforeEach, expect, test } from "bun:test";
import {
  CircuitBreaker,
  getBreaker,
  isPermanentError,
  resetAllBreakers,
  STATE,
} from "./circuit-breaker.js";

beforeEach(() => {
  resetAllBreakers();
});

const fail = () => Promise.reject(new Error("upstream down"));
const ok = (v = "fine") => Promise.resolve(v);

test("closed circuit passes calls through", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3 });
  expect(
    await cb.call(
      () => ok("a"),
      () => ok("fb"),
    ),
  ).toBe("a");
  expect(cb.state).toBe(STATE.CLOSED);
});

test("opens after threshold failures and fails fast", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 60000 });
  for (let i = 0; i < 3; i++) {
    await expect(cb.call(fail, () => ok("fb"))).rejects.toThrow(
      "upstream down",
    );
  }
  expect(cb.state).toBe(STATE.OPEN);
  // Fail fast: fn must NOT run, fallback runs instead.
  let ran = false;
  const out = await cb.call(
    () => {
      ran = true;
      return fail();
    },
    () => ok("fallback"),
  );
  expect(ran).toBe(false);
  expect(out).toBe("fallback");
});

test("half-open probe recovers on success", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 30 });
  await expect(cb.call(fail, () => ok("fb"))).rejects.toThrow();
  await expect(cb.call(fail, () => ok("fb"))).rejects.toThrow();
  expect(cb.state).toBe(STATE.OPEN);
  await new Promise((r) => setTimeout(r, 60));
  expect(
    await cb.call(
      () => ok("recovered"),
      () => ok("fb"),
    ),
  ).toBe("recovered");
  expect(cb.state).toBe(STATE.CLOSED);
});

test("failed half-open probe re-opens", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeout: 30 });
  await expect(cb.call(fail, () => ok("fb"))).rejects.toThrow();
  expect(cb.state).toBe(STATE.OPEN);
  await new Promise((r) => setTimeout(r, 60));
  await expect(cb.call(fail, () => ok("fb"))).rejects.toThrow("upstream down");
  expect(cb.state).toBe(STATE.OPEN);
});

test("success resets the failure count", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 60000 });
  await expect(cb.call(fail, () => ok("fb"))).rejects.toThrow();
  await expect(cb.call(fail, () => ok("fb"))).rejects.toThrow();
  await cb.call(
    () => ok("yes"),
    () => ok("fb"),
  );
  expect(cb.failures).toBe(0);
  expect(cb.state).toBe(STATE.CLOSED);
});

test("permanent client errors do not trip the breaker", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 60000 });
  const bad = () =>
    Promise.reject(Object.assign(new Error("bad"), { status: 400 }));
  await expect(cb.call(bad, () => ok("fb"))).rejects.toThrow("bad");
  await expect(cb.call(bad, () => ok("fb"))).rejects.toThrow("bad");
  expect(cb.failures).toBe(0);
  expect(cb.state).toBe(STATE.CLOSED);
});

test("resetTimeout uses jitter (not a fixed value)", () => {
  const cb = new CircuitBreaker({ resetTimeout: 1000, jitterRatio: 0.5 });
  const delays = new Set(
    Array.from({ length: 20 }, () => cb.nextResetDelay().toFixed(1)),
  );
  // With jitter, 20 samples should not all be identical.
  expect(delays.size).toBeGreaterThan(1);
  for (const d of delays) {
    expect(Number(d)).toBeGreaterThanOrEqual(500);
    expect(Number(d)).toBeLessThanOrEqual(1500);
  }
});

test("isPermanentError classification", () => {
  expect(isPermanentError(Object.assign(new Error("x"), { status: 400 }))).toBe(
    true,
  );
  expect(isPermanentError(Object.assign(new Error("x"), { status: 404 }))).toBe(
    true,
  );
  expect(isPermanentError(Object.assign(new Error("x"), { status: 429 }))).toBe(
    false,
  );
  expect(isPermanentError(Object.assign(new Error("x"), { status: 503 }))).toBe(
    false,
  );
  expect(isPermanentError(new Error("bad request"))).toBe(true);
  expect(isPermanentError(new Error("upstream down"))).toBe(false);
});

test("getBreaker returns one breaker per name", () => {
  const a = getBreaker("brave");
  const b = getBreaker("brave");
  const c = getBreaker("kagi");
  expect(a).toBe(b);
  expect(a).not.toBe(c);
  expect(a.name).toBe("brave");
});
