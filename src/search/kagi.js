import { parseKagiHtml, searchKagi } from "./kagibot/search.js";
import { emptyResults } from "./shape.js";

export { parseKagiHtml };

const DEAD_AT = 3;
const MAX_TRIES = 3;
const REQUEST_TIMEOUT_MS = 6000;
const BUDGET_MS = 12000;

async function pickSession(db, exclude) {
  const placeholders = exclude.length ? exclude.map(() => "?").join(",") : "";
  const row = await db
    .prepare(
      `SELECT id, cookie FROM sessions
       WHERE dead = 0${placeholders ? ` AND id NOT IN (${placeholders})` : ""}
       ORDER BY last_used_at ASC NULLS FIRST, fails ASC, id ASC
       LIMIT 1`,
    )
    .bind(...exclude)
    .first();
  return row || null;
}

async function markUsed(db, id) {
  await db
    .prepare("UPDATE sessions SET last_used_at = ?, fails = 0 WHERE id = ?")
    .bind(Date.now(), id)
    .run();
}

async function markFail(db, id) {
  await db
    .prepare(
      "UPDATE sessions SET fails = fails + 1, dead = CASE WHEN fails + 1 >= ? THEN 1 ELSE 0 END, last_used_at = ? WHERE id = ?",
    )
    .bind(DEAD_AT, Date.now(), id)
    .run();
}

function shape(items) {
  return {
    more_results_available: items.length >= 8,
    results: {
      ...emptyResults(),
      web: {
        results: items.map((r) => {
          let host = "";
          try {
            host = new URL(r.url).hostname.replace(/^www\./, "");
          } catch {}
          return {
            title: r.title,
            url: r.url,
            snippet: r.snippet || "",
            description: r.snippet || "",
            age: null,
            meta_url: host
              ? {
                  hostname: host,
                  favicon: `https://icons.duckduckgo.com/ip3/${host}.ico`,
                }
              : null,
            profile: host ? { name: host, img: null } : null,
            thumbnail: null,
            deep_results: null,
            cluster: null,
          };
        }),
      },
    },
  };
}

export default async function searchKagiWeb(query, page = 0, db) {
  if (!db) throw new Error("kagi session store unavailable");

  const started = Date.now();
  const tried = [];
  let lastErr = new Error("no live kagi sessions in bank");

  for (let i = 0; i < MAX_TRIES; i++) {
    const elapsed = Date.now() - started;
    if (elapsed > BUDGET_MS - REQUEST_TIMEOUT_MS) break;
    const session = await pickSession(db, tried);
    if (!session) break;
    tried.push(session.id);

    try {
      const data = await searchKagi(query, {
        cookie: session.cookie,
        page,
        timeoutMs: REQUEST_TIMEOUT_MS,
        signal: AbortSignal.timeout(BUDGET_MS - elapsed),
      });
      const items = data.results || [];
      if (!items.length) {
        lastErr = new Error("kagi session returned 0 results (likely dead)");
        await markFail(db, session.id);
        continue;
      }
      await markUsed(db, session.id);
      return shape(items);
    } catch (e) {
      const timedOut = e?.name === "AbortError" || e?.name === "TimeoutError";
      lastErr = timedOut ? new Error("kagi timed out") : e;
      if (timedOut || e?.status >= 500 || /fetch failed/i.test(e?.message))
        continue;
      await markFail(db, session.id);
    }
  }

  throw lastErr;
}
