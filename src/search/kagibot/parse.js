function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCharCode(Number.parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function cleanText(s) {
  return decodeEntities(String(s || "").replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapUrl(raw) {
  const decoded = decodeEntities(raw).trim();
  try {
    const u = new URL(decoded, "https://kagi.com");
    if (
      u.hostname.replace(/^www\./, "") === "kagi.com" &&
      (u.pathname === "/url" ||
        u.pathname === "/proxy" ||
        u.pathname === "/outgoing")
    ) {
      return u.searchParams.get("u") || u.searchParams.get("url") || u.href;
    }
    return u.href;
  } catch {
    return decoded;
  }
}

function matchTitleLink(html) {
  const patterns = [
    /<a[^>]*class="[^"]*__sri_title_link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    /<a[^>]*href="([^"]+)"[^>]*class="[^"]*__sri_title_link[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
    /<a[^>]*class="[^"]*__srgi-title[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    /<h3[^>]*class="[^"]*__sri-title-box[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return { url: m[1], title: m[2] };
  }
  return null;
}

function bestSnippet(html) {
  const texts = [];
  const re = /class="[^"]*__sri-desc[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = cleanText(
      m[1]
        .replace(/<span[^>]*__sri-time[^>]*>[\s\S]*?<\/span>/gi, " ")
        .replace(/<a[^>]*summarize-link[^>]*>[\s\S]*?<\/a>/gi, " "),
    );
    if (text) texts.push(text);
  }
  if (!texts.length) return "";
  const dated = /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/;
  const meat = texts.filter((t) => t.length > 24 && !dated.test(t));
  const pool = meat.length ? meat : texts.filter((t) => !dated.test(t));
  const pick = (pool.length ? pool : texts).sort(
    (a, b) => b.length - a.length,
  )[0];
  return pick || "";
}

function pushResult(results, seen, title, url, snippet) {
  const cleanTitle = cleanText(title);
  const cleanSnippet = cleanText(snippet);
  const cleanUrl = unwrapUrl(url);
  if (!cleanTitle || !cleanUrl) return;
  if (!/^https?:\/\//i.test(cleanUrl)) return;
  if (seen.has(cleanUrl)) return;
  seen.add(cleanUrl);
  results.push({
    title: cleanTitle,
    url: cleanUrl,
    snippet: cleanSnippet,
  });
}

function extractJsonResults(html, results, seen) {
  const scripts = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const script of scripts) {
    const body = script
      .replace(/^<script[^>]*>/i, "")
      .replace(/<\/script>$/i, "");
    const start = body.indexOf("{");
    if (start < 0) continue;
    const candidates = [];
    const sliced = body.slice(start);
    if (sliced.length > 2_000_000) continue;
    try {
      candidates.push(JSON.parse(sliced));
    } catch {}
    const objRe =
      /\{\s*"(?:t|url|title)"\s*:[\s\S]*?"(?:url|title|snippet|description)"\s*:[\s\S]*?\}/g;
    let m;
    while ((m = objRe.exec(body))) {
      try {
        candidates.push(JSON.parse(m[0]));
      } catch {}
    }
    const walk = (node) => {
      if (!node) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (typeof node !== "object") return;
      const url = node.url || node.href;
      const title = node.title || node.name;
      const snippet = node.snippet || node.description || node.desc || "";
      if (typeof url === "string" && typeof title === "string") {
        pushResult(results, seen, title, url, snippet);
      }
      for (const v of Object.values(node)) {
        if (v && typeof v === "object") walk(v);
      }
    };
    for (const c of candidates) walk(c);
  }
}

export function parseKagiHtml(html) {
  if (!html || typeof html !== "string") return [];
  const results = [];
  const seen = new Set();

  const chunks = html.split(/class="[^"]*search-result[^"]*"/i);
  for (const chunk of chunks.slice(1)) {
    const window = chunk.slice(0, 8000);
    const link = matchTitleLink(window);
    if (!link) continue;
    pushResult(results, seen, link.title, link.url, bestSnippet(window));
  }

  if (!results.length) {
    const grouped = html.split(/class="[^"]*__srgi[^"]*"/i);
    for (const chunk of grouped.slice(1)) {
      const window = chunk.slice(0, 4000);
      const link = matchTitleLink(window);
      if (!link) continue;
      pushResult(results, seen, link.title, link.url, bestSnippet(window));
    }
  }

  if (!results.length) extractJsonResults(html, results, seen);

  return results;
}
