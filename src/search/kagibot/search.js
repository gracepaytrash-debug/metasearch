import { parseKagiHtml } from "./parse.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

async function fetchHtml(url, cookie, timeoutMs = 20000, signal) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  signal?.addEventListener("abort", () => ac.abort(signal.reason), {
    once: true,
  });
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        cookie,
        pragma: "no-cache",
        "sec-ch-ua": '"Not?A_Brand";v="24", "Chromium";v="152"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
        "user-agent": UA,
      },
      redirect: "follow",
      signal: ac.signal,
    });
    const html = await resp.text();
    return { ok: resp.ok, status: resp.status, html, url: resp.url };
  } finally {
    clearTimeout(timer);
  }
}

export async function searchKagi(
  query,
  { cookie, page = 0, timeoutMs = 20000, signal } = {},
) {
  if (!query || typeof query !== "string") {
    throw new Error("query is required");
  }
  if (!cookie || typeof cookie !== "string") {
    throw new Error("kagi cookie required");
  }

  const q = encodeURIComponent(query);
  const pageQ = page ? `&batch=${page + 1}` : "";
  const primary = page
    ? `https://kagi.com/html/search?q=${q}${pageQ}`
    : `https://kagi.com/search?q=${q}`;
  const fetched = await fetchHtml(primary, cookie, timeoutMs, signal);
  if (!fetched.ok && fetched.status >= 400) {
    throw Object.assign(new Error(`kagi search failed: ${fetched.status}`), {
      status: fetched.status,
    });
  }
  let results = parseKagiHtml(fetched.html);
  let source = "https://kagi.com/search";
  if (!results.length) {
    const fallback = await fetchHtml(
      `https://kagi.com/html/search?q=${q}${pageQ}`,
      cookie,
      timeoutMs,
      signal,
    );
    results = parseKagiHtml(fallback.html);
    source = "https://kagi.com/html/search";
    if (!fallback.ok && !results.length) {
      throw Object.assign(
        new Error(`kagi html search failed: ${fallback.status}`),
        { status: fallback.status },
      );
    }
  }

  return {
    query,
    source,
    results: results
      .filter(
        (r) =>
          r.title &&
          r.url &&
          /^https?:\/\//i.test(r.url) &&
          String(r.snippet || "").trim(),
      )
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
      })),
  };
}

export { parseKagiHtml } from "./parse.js";
