import { parseQuery } from "../query.js";
import { getCached, setCached } from "./cache.js";
import { getBreaker } from "./circuit-breaker.js";
import { dedupKey, deduplicated } from "./dedup.js";
import searchImages from "./images.js";
import searchKagiWeb from "./kagi.js";
import searchMixed from "./mixed.js";
import searchNews from "./news.js";
import { retryAfterMs, withRetry, withTimeout } from "./resilient.js";
import { emptyResults } from "./shape.js";

function firstWeb(data) {
  const web = data?.results?.web?.results || [];
  const r = web.find((x) => x?.url && x?.title);
  if (!r) return;
  return {
    title: r.title,
    url: r.url,
    snippet: r.description || r.snippet || "",
  };
}

const hasAnything = (data, tab) => {
  const r = data?.results;
  if (!r) return false;
  if (tab === "images" || tab === "news") return Boolean(r.length);
  return Boolean(
    r.web?.results?.length ||
      r.news?.results?.length ||
      r.videos?.results?.length ||
      r.infobox?.results?.length ||
      r.discussions?.results?.length ||
      r.rich?.length,
  );
};

/**
 * Single engine call guarded by its circuit breaker, with optional bounded
 * retry for transient failures (off by default — opt in with `retries`).
 */
async function engineCall(
  eng,
  { q, tab, page, attempts, filters, db, clearance, retries = 0 },
) {
  const breaker = getBreaker(eng);

  const run = async () => {
    if (tab === "images")
      return searchImages(q, page, {
        attempts,
        clearance,
        safe: filters.safe,
      });
    if (tab === "news")
      return searchNews(q, page, {
        attempts,
        clearance,
        ...filters,
      });
    if (eng === "kagi") return searchKagiWeb(q, page, db);
    return searchMixed(q, page, {
      attempts,
      clearance,
      ...filters,
    });
  };

  const guarded = () =>
    breaker.call(run, () => {
      const err = new Error(`${eng} circuit open — skipped`);
      err.circuitOpen = true;
      err.engine = eng;
      throw err;
    });

  if (retries > 0) {
    return withRetry(guarded, {
      retries,
      label: `${eng} search`,
      getRetryAfter: (e) => retryAfterMs(e?.headers),
    });
  }
  return guarded();
}

/** Original behaviour: try engines in order, fall through on failure. */
async function searchSequential(args) {
  const {
    q,
    tab,
    page,
    order,
    attempts,
    filters,
    db,
    clearance,
    interactive,
    retries,
  } = args;
  const t0 = Date.now();
  let data;
  let used = order[0];
  const errors = [];
  let powRequired = false;
  for (const eng of order) {
    try {
      const attempt = await engineCall(eng, {
        q,
        tab,
        page,
        attempts,
        filters,
        db,
        clearance,
        retries,
      });
      const ok = hasAnything(attempt, tab);
      if (ok || !data) {
        data = attempt;
        used = eng;
      }
      if (ok) break;
    } catch (e) {
      errors.push({ engine: eng, error: e });
      if (interactive && e?.pow && !data) {
        powRequired = true;
        break;
      }
    }
  }
  return { data, used, order, errors, powRequired, took: Date.now() - t0 };
}

/**
 * Parallel mode: race all engines with a per-engine timeout, merge the
 * winners. Partial results beat waiting for the slowest engine.
 */
async function searchParallel(args) {
  const {
    q,
    tab,
    page,
    order,
    attempts,
    filters,
    db,
    clearance,
    engineTimeout = 8000,
  } = args;
  const t0 = Date.now();

  const settled = await Promise.allSettled(
    order.map((eng) =>
      withTimeout(
        engineCall(eng, { q, tab, page, attempts, filters, db, clearance }),
        engineTimeout,
        `${eng} search`,
      ),
    ),
  );

  const candidates = [];
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && hasAnything(r.value, tab)) {
      candidates.push({ eng: order[i], data: r.value });
    } else if (r.status === "rejected") {
      errors.push({ engine: order[i], error: r.reason });
    } else if (r.status === "fulfilled") {
      // Fulfilled but empty — keep as last-resort data, not an error.
      candidates.push({ eng: order[i], data: r.value, empty: true });
    }
  });

  // Prefer non-empty candidates, preserving engine order.
  candidates.sort((a, b) => (a.empty ? 1 : 0) - (b.empty ? 1 : 0));

  let data = null;
  let used = order[0];
  let mergedFrom = [];
  if (candidates.length) {
    const winners = candidates.filter((c) => !c.empty);
    const pool = winners.length ? winners : candidates;
    used = pool[0].eng;
    mergedFrom = pool.map((c) => c.eng);
    data = mergeCandidates(pool, tab);
  }

  return {
    data,
    used,
    order,
    errors,
    powRequired: false,
    mergedFrom,
    took: Date.now() - t0,
  };
}

/** Merge web results from parallel engines, deduplicating by URL. */
function mergeCandidates(pool, tab) {
  if (pool.length === 1) return pool[0].data;
  if (tab === "images" || tab === "news") {
    // Arrays — concatenate and dedupe by url where available.
    const seen = new Set();
    const merged = [];
    for (const { data } of pool) {
      for (const r of data?.results || []) {
        const key = r?.url || JSON.stringify(r);
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(r);
        }
      }
    }
    return { ...pool[0].data, results: merged };
  }
  const seen = new Set();
  const webResults = [];
  for (const { data } of pool) {
    for (const r of data?.results?.web?.results || []) {
      if (r?.url && !seen.has(r.url)) {
        seen.add(r.url);
        webResults.push(r);
      }
    }
  }
  const primary = pool[0].data;
  return {
    ...primary,
    results: {
      ...primary.results,
      web: { ...(primary.results?.web || {}), results: webResults },
    },
  };
}

/** Shared output shaping (unchanged contract from the original run.js). */
function finalize({
  data,
  used,
  order,
  errors,
  powRequired,
  mergedFrom,
  tab,
  page,
  parsed,
  took,
  fromCache,
  stale,
}) {
  const failed = !data;
  if (!data) data = { more_results_available: false, results: emptyResults() };

  const web = data?.results?.web?.results;
  if (Array.isArray(web)) {
    data.results.web.results = web.map((r) => ({
      ...r,
      snippet: r.snippet || r.description || "",
      description: r.description || r.snippet || "",
    }));
  }

  const first_result = parsed.firstResult ? firstWeb(data) : undefined;
  const outType = tab === "videos" ? "web" : tab;

  return {
    query: parsed.query,
    type: outType,
    page,
    engine: used,
    took,
    ...(used !== order[0]
      ? {
          fallback_from: order[0],
          fallback_reason: errors.find((e) => e.engine === order[0])?.error
            ?.blocked
            ? "is rate limited"
            : "didn't answer",
        }
      : {}),
    ...(mergedFrom && mergedFrom.length > 1 ? { merged_from: mergedFrom } : {}),
    ...(powRequired ? { pow_required: true } : {}),
    ...(fromCache ? { from_cache: true } : {}),
    ...(stale ? { stale: true } : {}),
    ...(failed
      ? {
          search_error: errors
            .map((e) => `${e.engine}: ${String(e.error?.message || e.error)}`)
            .join("; "),
        }
      : {}),
    parsed,
    ...(first_result ? { first_result } : {}),
    ...data,
  };
}

export async function runSearch({
  query,
  type = "web",
  page = 0,
  engines = ["brave"],
  lens,
  db,
  clearance,
  interactive = false,
  safe,
  time,
  // ---- resilience options (all opt-in; defaults preserve old behaviour) ----
  parallel = false, // race engines concurrently, merge winners
  cache = false, // edge cache (Cache API) with stale-while-revalidate
  dedup = true, // collapse concurrent identical requests
  skipCache = false, // force fresh fetch even when cache is enabled
  retries = 0, // bounded retries for transient failures (0 = off)
  engineTimeout = 8000, // per-engine timeout in parallel mode
  ctx, // execution context for waitUntil (background revalidation)
} = {}) {
  const filters = {
    safe: ["off", "moderate", "strict"].includes(safe) ? safe : undefined,
    time: ["pd", "pw", "pm", "py"].includes(time) ? time : undefined,
  };
  const parsed = parseQuery(query, { lens });
  if (parsed.redirectUrl) {
    return { query, type, page, redirect: parsed.redirectUrl, parsed };
  }

  const tab = parsed.tab || type || "web";
  const q = parsed.engineQuery || parsed.query || "";
  const webTab = tab !== "images" && tab !== "news" && tab !== "maps";
  const order = engines.filter(
    (e, i, a) => a.indexOf(e) === i && (webTab || e === "brave"),
  );
  if (!order.length) order.push("brave");
  const attempts = order.length > 1 ? 1 : 2;

  const t0 = Date.now();
  const searchArgs = {
    q,
    tab,
    page,
    order,
    attempts,
    filters,
    db,
    clearance,
    interactive,
    retries,
    engineTimeout,
  };

  // ---- edge cache: fresh hit serves instantly ----
  const cacheable = cache && !skipCache && page === 0 && !interactive && q;
  if (cacheable) {
    const hit = await getCached(q, tab, page);
    if (hit && !hit.stale) {
      return finalize({
        data: hit.data,
        used: hit.data.engine || order[0],
        order,
        errors: [],
        powRequired: false,
        tab,
        page,
        parsed,
        took: Date.now() - t0,
        fromCache: true,
      });
    }
    if (hit?.stale) {
      // Serve stale now; refresh in the background when possible.
      if (ctx?.waitUntil) {
        ctx.waitUntil(
          (async () => {
            const fresh = parallel
              ? await searchParallel({ ...searchArgs, dedup: false })
              : await searchSequential(searchArgs);
            const out = finalize({
              ...fresh,
              tab,
              page,
              parsed,
            });
            if (!out.search_error) await setCached(q, tab, page, out);
          })().catch(() => {}),
        );
      }
      return finalize({
        data: hit.data,
        used: hit.data.engine || order[0],
        order,
        errors: [],
        powRequired: false,
        tab,
        page,
        parsed,
        took: Date.now() - t0,
        fromCache: true,
        stale: true,
      });
    }
  }

  // ---- live search (dedup concurrent identical requests) ----
  const doSearch = () =>
    parallel ? searchParallel(searchArgs) : searchSequential(searchArgs);
  const fresh = dedup
    ? await deduplicated(
        dedupKey(q, tab, page, order, parallel ? "p" : "s"),
        doSearch,
      )
    : await doSearch();

  const out = finalize({ ...fresh, tab, page, parsed });

  // ---- populate the cache (failures are never cached) ----
  if (cacheable && !out.search_error) {
    if (ctx?.waitUntil) ctx.waitUntil(setCached(q, tab, page, out));
    else await setCached(q, tab, page, out);
  }

  return out;
}
