/**
 * /api/kronos/trend — rolling daily hit-rate over the last 7 days.
 *
 * We don't keep a snapshot DB because we don't need one: the source data
 * (Kronos-demo git history + Binance prices) is durable and recomputable.
 * This endpoint pulls 168 hourly forecasts, scores each, and buckets them
 * into 7 daily groups so the KRONOS tab can render a sparkline + day-over-
 * day deltas.
 *
 * Cost-per-call: 1 GitHub commits-list + ~150 raw.githubusercontent + 1
 * Binance klines range query. Heavy work; cached 12 h fresh + 24 h stale.
 * A daily cron at 06:00 UTC re-warms it so users always hit cache.
 *
 * Query:
 *   GET /api/kronos/trend           → 7-day rolling, default
 *   GET /api/kronos/trend?days=14   → up to 14 days (slower)
 */

export const config = { runtime: 'edge' };

const REPO_API_BASE = 'https://api.github.com/repos/shiyu-coder/Kronos-demo';
const REPO_RAW_BASE = 'https://raw.githubusercontent.com/shiyu-coder/Kronos-demo';

const GH_HEADERS = {
  'User-Agent': 'shift-2.0/kronos-trend',
  'Accept': 'application/vnd.github+json',
};

/* deriveSignal — must match /api/kronos.js and /api/kronos/backtest.js */
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
  return { action, tier, edge };
}

const extract = (html, id) => {
  const re = new RegExp(`id="${id}"[^>]*>\\s*([^<]+?)\\s*<`, 'i');
  const m = html.match(re);
  return m ? m[1].trim() : null;
};

const pct = (s) => Number(String(s ?? '').replace('%', ''));
const round2 = (n) => Math.round(n * 100) / 100;

/* Paginated commits — GitHub /commits returns 100 per page max */
async function fetchCommits(sinceMs) {
  const sinceIso = new Date(sinceMs).toISOString();
  const all = [];
  for (let page = 1; page <= 3; page++) {
    const r = await fetch(
      `${REPO_API_BASE}/commits?since=${sinceIso}&per_page=100&page=${page}`,
      { headers: GH_HEADERS, cache: 'no-store' }
    );
    if (!r.ok) break;
    const arr = await r.json();
    if (!arr?.length) break;
    all.push(...arr);
    if (arr.length < 100) break;
  }
  return all;
}

async function fetchKronosAtSha(sha) {
  const r = await fetch(`${REPO_RAW_BASE}/${sha}/index.html`, { cache: 'no-store' });
  if (!r.ok) return null;
  const html = await r.text();
  return {
    upsidePct: extract(html, 'upside-prob'),
    volAmpPct: extract(html, 'vol-amp-prob'),
  };
}

async function fetchKlinesRange(startMs, endMs) {
  const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${startMs}&endTime=${endMs}&limit=1000`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`binance ${r.status}`);
  return r.json();
}

function priceAt(klines, tsMs) {
  if (!klines?.length) return null;
  let best = null, bd = Infinity;
  for (const k of klines) {
    const d = Math.abs(+k[0] - tsMs);
    if (d < bd) { bd = d; best = k; }
  }
  if (!best || bd > 90 * 60_000) return null;
  return +best[4];
}

/** UTC day key in YYYY-MM-DD form */
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

export default async function handler(request) {
  const u = new URL(request.url);
  const days = Math.min(14, Math.max(3, +u.searchParams.get('days') || 7));
  const windowHours = days * 24;

  try {
    const now = Date.now();
    const windowStart = now - windowHours * 3600_000;

    const [commits, klines] = await Promise.all([
      fetchCommits(windowStart),
      fetchKlinesRange(windowStart - 2 * 3600_000, now),
    ]);

    // Filter to hourly Auto-update commits and dedupe by hour bucket
    const seen = new Set();
    const hourly = [];
    for (const c of commits) {
      if (!/Auto-update forecast/i.test(c.commit?.message || '')) continue;
      const ts = new Date(c.commit?.committer?.date || 0).getTime();
      const hourBucket = Math.floor(ts / 3600_000);
      if (seen.has(hourBucket)) continue;
      seen.add(hourBucket);
      hourly.push({ sha: c.sha, ts });
    }

    // Only score forecasts whose T+24h has resolved (otherwise we have no truth)
    const resolvable = hourly.filter(({ ts }) => ts + 24 * 3600_000 <= now);

    // Fetch + score in parallel batches of 30 to be polite to the CDN
    const scored = [];
    const BATCH = 30;
    for (let i = 0; i < resolvable.length; i += BATCH) {
      const batch = resolvable.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async ({ sha, ts }) => {
        const k = await fetchKronosAtSha(sha);
        if (!k) return null;
        const sig = deriveSignal(pct(k.upsidePct), pct(k.volAmpPct));
        const pT    = priceAt(klines, ts);
        const pT24h = priceAt(klines, ts + 24 * 3600_000);
        if (pT == null || pT24h == null) return null;
        const ret = (pT24h - pT) / pT * 100;
        let correct = null;
        if (sig.action === 'BUY')  correct = ret > 0;
        if (sig.action === 'SELL') correct = ret < 0;
        return { ts, action: sig.action, ret, correct };
      }));
      scored.push(...results.filter(Boolean));
    }

    // Bucket by UTC day
    const buckets = new Map();
    for (const s of scored) {
      const k = dayKey(s.ts);
      if (!buckets.has(k)) buckets.set(k, { day: k, all: [], buy: [], sell: [], hold: [] });
      const b = buckets.get(k);
      b.all.push(s);
      if (s.action === 'BUY')  b.buy.push(s);
      if (s.action === 'SELL') b.sell.push(s);
      if (s.action === 'HOLD') b.hold.push(s);
    }

    // Compose day-by-day stats — fill missing days with nulls so the
    // sparkline renders gaps correctly.
    const series = [];
    for (let d = days - 1; d >= 0; d--) {
      const dayMs = now - d * 24 * 3600_000;
      const k = dayKey(dayMs);
      const b = buckets.get(k);
      if (!b) {
        series.push({ day: k, samples: 0, directional: 0, hitRate: null, avgRet: null });
        continue;
      }
      const directional = b.buy.concat(b.sell);
      const right = directional.filter((s) => s.correct === true).length;
      const hit = directional.length ? right / directional.length * 100 : null;
      // Avg directional P&L (SELL is short → flip sign)
      const pnl = directional.length
        ? directional.reduce((a, s) => a + (s.action === 'SELL' ? -s.ret : s.ret), 0) / directional.length
        : null;
      series.push({
        day: k,
        samples: b.all.length,
        directional: directional.length,
        buyN:  b.buy.length,
        sellN: b.sell.length,
        holdN: b.hold.length,
        hitRate: hit == null ? null : round2(hit),
        avgRet: pnl == null ? null : round2(pnl),
      });
    }

    // Day-over-day delta on hit rate
    const valid = series.filter((s) => s.hitRate != null);
    const lastHit = valid.length ? valid[valid.length - 1].hitRate : null;
    const prevHit = valid.length > 1 ? valid[valid.length - 2].hitRate : null;
    const delta   = (lastHit != null && prevHit != null) ? round2(lastHit - prevHit) : null;

    // Trend direction over the whole window: positive slope = improving
    let slope = null;
    if (valid.length >= 3) {
      const n = valid.length;
      const xs = valid.map((_, i) => i);
      const ys = valid.map((s) => s.hitRate);
      const xMean = xs.reduce((a, b) => a + b, 0) / n;
      const yMean = ys.reduce((a, b) => a + b, 0) / n;
      let num = 0, den = 0;
      for (let i = 0; i < n; i++) { num += (xs[i] - xMean) * (ys[i] - yMean); den += (xs[i] - xMean) ** 2; }
      slope = den === 0 ? 0 : round2(num / den);
    }

    return json(200, {
      ok: true,
      days,
      totalSamples: scored.length,
      series,
      latest: { day: series[series.length - 1]?.day, hitRate: lastHit, delta },
      slope, // hit-rate pts per day of trend
      fetchedAt: new Date().toISOString(),
    }, /*sMaxAge*/ 12 * 3600, /*swr*/ 24 * 3600);
  } catch (e) {
    return json(502, { ok: false, error: String(e?.message || e).slice(0, 200) });
  }
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
