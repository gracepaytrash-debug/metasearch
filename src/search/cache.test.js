import { beforeEach, expect, test } from "bun:test";
import {
  cacheKey,
  clearMemoryCache,
  FRESH_TTL,
  getCached,
  STALE_TTL,
  setCached,
} from "./cache.js";

beforeEach(() => {
  clearMemoryCache();
});

test("cacheKey is deterministic and encodes query safely", () => {
  const a = cacheKey("hello world", "web", 0);
  const b = cacheKey("hello world", "web", 0);
  const c = cacheKey("hello world", "web", 1);
  const d = cacheKey("hello world", "news", 0);
  expect(a).toBe(b);
  expect(a).not.toBe(c);
  expect(a).not.toBe(d);
  expect(a).toContain(encodeURIComponent("hello world"));
});

test("miss returns null on empty cache", async () => {
  expect(await getCached(`nope-${Math.random()}`, "web", 0)).toBeNull();
});

test("set then get returns fresh entry", async () => {
  const q = `fresh-${Math.random()}`;
  const data = { results: { web: { results: [{ title: "t" }] } } };
  await setCached(q, "web", 0, data);
  const hit = await getCached(q, "web", 0);
  expect(hit).not.toBeNull();
  expect(hit.stale).toBe(false);
  expect(hit.data).toEqual(data);
});

test("failures are never cached", async () => {
  const q = `fail-${Math.random()}`;
  await setCached(q, "web", 0, { search_error: "brave: down" });
  expect(await getCached(q, "web", 0)).toBeNull();
});

test("null/undefined data is never cached", async () => {
  const q = `null-${Math.random()}`;
  await setCached(q, "web", 0, null);
  await setCached(q, "web", 0, undefined);
  expect(await getCached(q, "web", 0)).toBeNull();
});

test("stale entry is served with stale=true (SWR window)", async () => {
  const q = `stale-${Math.random()}`;
  const data = { results: { web: { results: [] } } };
  await setCached(q, "web", 0, data);

  // Simulate age inside the stale window by monkey-patching Date.now
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + (FRESH_TTL + 60) * 1000;
    const hit = await getCached(q, "web", 0);
    expect(hit).not.toBeNull();
    expect(hit.stale).toBe(true);
    expect(hit.data).toEqual(data);
  } finally {
    Date.now = realNow;
  }
});

test("expired entry is a miss", async () => {
  const q = `expired-${Math.random()}`;
  await setCached(q, "web", 0, { results: {} });
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + (STALE_TTL + 60) * 1000;
    expect(await getCached(q, "web", 0)).toBeNull();
  } finally {
    Date.now = realNow;
  }
});

test("different pages and types are isolated", async () => {
  const q = `iso-${Math.random()}`;
  await setCached(q, "web", 0, { marker: "web0" });
  await setCached(q, "web", 1, { marker: "web1" });
  await setCached(q, "news", 0, { marker: "news0" });
  expect((await getCached(q, "web", 0)).data.marker).toBe("web0");
  expect((await getCached(q, "web", 1)).data.marker).toBe("web1");
  expect((await getCached(q, "news", 0)).data.marker).toBe("news0");
});
