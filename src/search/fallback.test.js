import { expect, mock, test } from "bun:test";

const { parseKagiHtml } = await import("./kagibot/parse.js");
const calls = [];
let braveMode = "429";
mock.module("./mixed.js", () => ({
  default: async () => {
    calls.push("brave");
    if (braveMode === "429")
      throw Object.assign(new Error("brave 429"), {
        status: 429,
        blocked: true,
      });
    if (braveMode === "parse")
      throw new Error("brave parse failed (200, 42910b)");
    return {
      more_results_available: true,
      results: {
        web: { results: [{ title: "b", url: "https://b" }] },
        mixed: [],
      },
    };
  },
}));
mock.module("./kagi.js", () => ({
  default: async () => {
    calls.push("kagi");
    return {
      more_results_available: true,
      results: {
        web: { results: [{ title: "k", url: "https://k" }] },
        mixed: [],
      },
    };
  },
  parseKagiHtml,
}));

const { runSearch } = await import("./run.js");

test("brave 429 falls back to kagi and reports the reason", async () => {
  const out = await runSearch({
    query: "rice",
    engines: ["brave", "kagi"],
    db: {},
  });
  expect(calls).toEqual(["brave", "kagi"]);
  expect(out.engine).toBe("kagi");
  expect(out.fallback_from).toBe("brave");
  expect(out.fallback_reason).toBe("is rate limited");
  expect(out.search_error).toBeUndefined();
});

test("a parse failure is not reported as rate limiting", async () => {
  calls.length = 0;
  braveMode = "parse";
  const out = await runSearch({
    query: "rice",
    engines: ["brave", "kagi"],
    db: {},
  });
  expect(out.engine).toBe("kagi");
  expect(out.fallback_reason).toBe("didn't answer");
});

test("brave is tried first again on the next request", async () => {
  calls.length = 0;
  braveMode = "ok";
  const out = await runSearch({
    query: "rice",
    engines: ["brave", "kagi"],
    db: {},
  });
  expect(calls).toEqual(["brave"]);
  expect(out.engine).toBe("brave");
  expect(out.fallback_from).toBeUndefined();
});

test("brave alone reports its own failure", async () => {
  calls.length = 0;
  braveMode = "429";
  const out = await runSearch({ query: "rice", engines: ["brave"] });
  expect(calls).toEqual(["brave"]);
  expect(out.engine).toBe("brave");
  expect(out.fallback_from).toBeUndefined();
  expect(out.search_error).toBe("brave: brave 429");
});
