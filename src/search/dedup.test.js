import { beforeEach, expect, test } from "bun:test";
import {
  clearInflight,
  dedupKey,
  deduplicated,
  inflightSize,
} from "./dedup.js";

beforeEach(() => {
  clearInflight();
});

test("dedupKey is stable and distinguishes inputs", () => {
  expect(dedupKey("q", "web", 0, ["brave"])).toBe(
    dedupKey("q", "web", 0, ["brave"]),
  );
  expect(dedupKey("q", "web", 0, ["brave"])).not.toBe(
    dedupKey("q", "web", 0, ["kagi"]),
  );
  expect(dedupKey("q", "web", 0, ["brave"])).not.toBe(
    dedupKey("q", "web", 1, ["brave"]),
  );
  // engine order doesn't matter
  expect(dedupKey("q", "web", 0, ["brave", "kagi"])).toBe(
    dedupKey("q", "web", 0, ["kagi", "brave"]),
  );
});

test("concurrent identical requests share one execution", async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return { n: calls };
  };
  const key = `k-${Math.random()}`;
  const [a, b, c] = await Promise.all([
    deduplicated(key, fn),
    deduplicated(key, fn),
    deduplicated(key, fn),
  ]);
  expect(calls).toBe(1);
  expect(a).toBe(b);
  expect(b).toBe(c);
  expect(a.n).toBe(1);
});

test("entry is dropped after settle — sequential calls re-execute", async () => {
  let calls = 0;
  const key = `seq-${Math.random()}`;
  await deduplicated(key, async () => {
    calls++;
    return 1;
  });
  // microtask flush so .finally() cleanup runs
  await new Promise((r) => setTimeout(r, 0));
  expect(inflightSize()).toBe(0);
  await deduplicated(key, async () => {
    calls++;
    return 2;
  });
  expect(calls).toBe(2);
});

test("rejections are shared and entry is still dropped", async () => {
  let calls = 0;
  const key = `rej-${Math.random()}`;
  const fn = async () => {
    calls++;
    throw new Error("boom");
  };
  const results = await Promise.allSettled([
    deduplicated(key, fn),
    deduplicated(key, fn),
  ]);
  expect(calls).toBe(1);
  expect(results[0].status).toBe("rejected");
  expect(results[1].status).toBe("rejected");
  await new Promise((r) => setTimeout(r, 0));
  expect(inflightSize()).toBe(0);
});

test("different keys do not interfere", async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    return calls;
  };
  const [a, b] = await Promise.all([
    deduplicated(`a-${Math.random()}`, fn),
    deduplicated(`b-${Math.random()}`, fn),
  ]);
  expect(calls).toBe(2);
  expect(a).toBe(1);
  expect(b).toBe(2);
});
