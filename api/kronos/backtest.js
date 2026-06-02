/**
 * /api/kronos/backtest — rolling hit-rate of our SHIFT signal on real history.
 *
 * The Kronos-demo repo commits one updated forecast per hour. We:
 *   1. Pull the last N commits via the GitHub API
 *   2. For each commit, fetch its raw index.html and extract upside / vol-amp
 *   3. Pull the matching Binance 1h klines spanning the same window plus 24h
 *   4. For each historical forecast at time T:
 *      - apply the SAME deriveSignal() the live card uses
 *      - look up the close price at T and the close price at T + 24h
 *      - score: BUY right ⇔ price up, SELL right ⇔ price down
 *      - HOLD signals don't count toward accuracy (no directional bet)
 *   5. Aggregate hit-rate, average return per directional trade, recent streak
 *
 * Defaults: window = 72 hours (3 days) → meaningful sample, fast to compute.
 * Cached at the edge for 30 min so the cron warmup keeps it instant.
 */

export const config = { runtime: 'edge' };

const REPO_API_BASE = 'https://api.github.com/repos/shiyu-coder/Kronos-demo';
const REPO_RAW_BASE = 'https://raw.githubusercontent.com/shiyu-coder/Kronos-demo';

const GH_HEADERS = {
  'User-Agent': 'shift-2.0/kronos-backtest',
  'Accept': 'application/vnd.github+json',
};

/* ---- duplicate of deriveSignal from /api/kronos.js ----
 * Inlined deliberately: edge functions don't always bundle imports cleanly,
 * and keeping the rules in two places fails loudly if they ever diverge
 * (the backtest hit rate would jump for no reason). */
function deriveSignal(upside, volAmp) {
  const u = Number(upside) || 50;
  const v = Number(volAmp) || 50;
  const edge = Math.abs(u - 50);
  let tier;
  if      (edge >= 25) tier = 3;
  else if (edge >= 15) tier = 2;
  else if (edge >= 8)  tier = 1;
  else                 tier = 0;
  if (v >= 85) tier = Math.max(0, tier - 1);
  const baseDir = u >= 50 ? 'LONG' : 'SHORT';
  const direction = tier === 0 ? 'NEUTRAL' : baseDir;
  let action;
  if (direction === 'NEUTRAL') action = 'HOLD';
  else if (v >= 85 && tier <= 1) action = 'HOLD';
  else if (direction === 'LONG') action = 'BUY';
  else action = 'SELL';
  return { action, direction, edge, tier };
}

const extract = (html, id) => {
  const re = new RegExp(`id="${id}"[^>]*>\\s*([^<]+?)\\s*<`, 'i');
  const m = html.match(re);
  return m ? m[1].trim() : null;
};

const pct = (s) => Number(String(s ?? '').replace('%', ''));
const round2 = (n) => Math.round(n * 100) / 100;

/* ---- Fetchers ---- */
async function fetchCommits(sinceMs) {
  const sinceIso = new Date(sinceMs).toISOString();
  const r = await fetch(
    `${REPO_API_BASE}/commits?since=${sinceIso}&per_page=100`,
    { headers: GH_HEADERS, cache: 'no-store' }
  );
  if (!r.ok) throw new Error(`github commits ${r.status}`);
  return r.json();
}

async function fetchKronosAtSha(sha) {
  const r = await fetch(`${REPO_RAW_BASE}/${sha}/index.html`, { cache: 'no-store' });
  if (!r.ok) return null;
  const html = await r.text();
  return {
    updatedAt: extract(html, 'update-time'),
    upsidePct: extract(html, 'upside-prob'),
    volAmpPct: extract(html, 'vol-amp-prob'),
  };
}

/**
 * One Binance request for an hour-aligned series covering [startMs, endMs].
 * Binance returns at most 1000 bars; for our windows (≤ 4 days × 24h) we're
 * always well under that.
 */
async function fetchKlinesRange(startMs, endMs) {
  const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${startMs}&endTime=${endMs}&limit=500`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`binance ${r.status}`);
  return r.json(); // [[openTime, open, high, low, close, ...], ...]
}

/** Find the kline whose openTime is closest to tsMs (within a 1h window). */
function priceAt(klines, tsMs) {
  if (!klines?.length) return null;
  let best = null, bestDelta = Infinity;
  for (const k of klines) {
    const d = Math.abs(+k[0] - tsMs);
    if (d < bestDelta) { bestDelta = d; best = k; }
  }
  if (!best || bestDelta > 90 * 60_000) return null; // > 90 min off = give up
  return +best[4]; // close
}

/* ---- handler ---- */
export default async function handler(request) {
  const u = new URL(request.url);
  const windowHours = Math.min(168, Math.max(24, +u.searchParams.get('hours') || 72));

  try {
    const now = Date.now();
    const windowStart = now - windowHours * 3600_000;
    // We need price data for forecast time T AND T+24h, so pull klines
    // from windowStart through now (now covers T+24 for everything ≤ now-24h)
    const klinesStart = windowStart - 2 * 3600_000;
    const klinesEnd   = now;

    const [commits, klines] = await Promise.all([
      fetchCommits(windowStart),
      fetchKlinesRange(klinesStart, klinesEnd),
    ]);

    if (!commits?.length) return json(200, { ok: true, windowHours, samples: 0, stats: emptyStats() });

    // Filter to hourly cron commits — they're titled
    // "Auto-update forecast for YYYY-MM-DD HH:MM UTC"
    const hourly = commits.filter((c) => /Auto-update forecast/i.test(c.commit?.message || ''));

    // Deduplicate by hour bucket so we score one signal per hour even if the
    // cron pushed twice in the same hour.
    const seen = new Set();
    const deduped = [];
    for (const c of hourly) {
      const ts = new Date(c.commit?.committer?.date || 0).getTime();
      const hourBucket = Math.floor(ts / 3600_000);
      if (seen.has(hourBucket)) continue;
      seen.add(hourBucket);
      deduped.push(c);
    }

    // Only keep forecasts where we have a full T+24h actual price (the
    // hold has fully resolved). That's any forecast where T + 24h ≤ now.
    const resolvable = deduped.filter((c) => {
      const ts = new Date(c.commit?.committer?.date || 0).getTime();
      return ts + 24 * 3600_000 <= now;
    });

    // Fetch all the HTMLs in parallel — raw.githubusercontent is a CDN
    // and shrugs off this load. With 72 entries it finishes in ~3s on
    // a warm edge.
    const forecasts = await Promise.all(resolvable.map(async (c) => {
      const k = await fetchKronosAtSha(c.sha);
      if (!k) return null;
      const ts = new Date(c.commit?.committer?.date || 0).getTime();
      return {
        ts,
        committedAt: c.commit?.committer?.date,
        upside: pct(k.upsidePct),
        volAmp: pct(k.volAmpPct),
      };
    }));

    // Score each forecast
    const scored = [];
    for (const f of forecasts) {
      if (!f) continue;
      const sig = deriveSignal(f.upside, f.volAmp);
      const priceT    = priceAt(klines, f.ts);
      const priceT24h = priceAt(klines, f.ts + 24 * 3600_000);
      if (priceT == null || priceT24h == null) continue;

      const ret = (priceT24h - priceT) / priceT * 100;
      let correct = null;
      if (sig.action === 'BUY')  correct = ret > 0;
      if (sig.action === 'SELL') correct = ret < 0;

      scored.push({
        ts: f.committedAt,
        upside: f.upside,
        volAmp: f.volAmp,
        action: sig.action,
        priceT:    round2(priceT),
        priceT24h: round2(priceT24h),
        returnPct: round2(ret),
        correct,
      });
    }

    // Aggregate
    const buy  = scored.filter((s) => s.action === 'BUY');
    const sell = scored.filter((s) => s.action === 'SELL');
    const hold = scored.filter((s) => s.action === 'HOLD');
    const directional = buy.concat(sell);

    const stat = (arr, signFlip = false) => {
      const right = arr.filter((s) => s.correct === true).length;
      const n = arr.length;
      const avgRet = n
        ? arr.reduce((a, s) => a + (signFlip ? -s.returnPct : s.returnPct), 0) / n
        : 0;
      return {
        n,
        right,
        hitRate: n ? round2(right / n * 100) : 0,
        avgReturn: round2(avgRet),
      };
    };

    const stats = {
      totalSignals: scored.length,
      buy:  stat(buy,  false),
      sell: stat(sell, true),       // SELL P&L = price drop, so flip sign
      hold: { n: hold.length },
      overall: stat(directional, false),   // direction-agnostic hit on directional only
    };
    // For overall hit rate we want directional correctness, not P&L
    const dirRight = directional.filter((s) => s.correct === true).length;
    stats.overall.hitRate = directional.length
      ? round2(dirRight / directional.length * 100)
      : 0;
    stats.overall.right = dirRight;

    // Recent streak — last 10 directional signals, true/false/null
    const recent = directional.slice(-10);
    stats.recentStreak = recent.map((s) => s.correct);

    return json(200, {
      ok: true,
      windowHours,
      samples: scored.length,
      stats,
      detail: scored,
      fetchedAt: new Date().toISOString(),
    }, /*sMaxAge*/ 1800, /*swr*/ 3600);
  } catch (e) {
    return json(502, { ok: false, error: String(e?.message || e).slice(0, 200) });
  }
}

function emptyStats() {
  return {
    totalSignals: 0,
    buy:  { n: 0, right: 0, hitRate: 0, avgReturn: 0 },
    sell: { n: 0, right: 0, hitRate: 0, avgReturn: 0 },
    hold: { n: 0 },
    overall: { n: 0, right: 0, hitRate: 0, avgReturn: 0 },
    recentStreak: [],
  };
}

function json(status, payload, sMaxAge = 0, swr = 0) {
  const cache = sMaxAge
    ? `public, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`
    : 'no-store';
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': cache,
    },
  });
}
