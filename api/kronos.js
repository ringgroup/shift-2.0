/**
 * /api/kronos — composite endpoint for the day-trade dashboard.
 *
 * Sources of truth, all upstream:
 *   - Kronos forecast values come from the static demo at
 *     https://shiyu-coder.github.io/Kronos-demo/ (regenerated hourly by
 *     the maintainer's CI; we scrape the rendered HTML).
 *   - BTC spot, recent klines, ATR, 24h range come from Binance's public
 *     market-data API (no auth, no quota for our usage).
 *   - The last-24h recap pulls the Kronos-demo git commit closest to
 *     T-24h via the GitHub API + raw.githubusercontent.com.
 *
 * The signal logic (BUY / HOLD / SELL + entry/stop/target) lives here so
 * /api/kronos and /api/kronos/backtest produce identical decisions — what
 * the user sees in the live card is the same function being scored in the
 * backtest.
 *
 * Modes:
 *   GET /api/kronos              → composite JSON (live signal, levels, recap)
 *   GET /api/kronos?chart=1      → PNG passthrough of the Kronos forecast chart
 *
 * Edge-cached 5 min fresh + 30 min stale. Upstream regenerates hourly.
 */

export const config = { runtime: 'edge' };

const DEMO_URL  = 'https://shiyu-coder.github.io/Kronos-demo/';
const CHART_URL = 'https://shiyu-coder.github.io/Kronos-demo/prediction_chart.png';
const REPO_API_BASE  = 'https://api.github.com/repos/shiyu-coder/Kronos-demo';
const REPO_RAW_BASE  = 'https://raw.githubusercontent.com/shiyu-coder/Kronos-demo';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/png,*/*;q=0.5',
  'Accept-Language': 'en-US,en;q=0.9',
};
const GH_HEADERS = {
  'User-Agent': 'shift-2.0/kronos',
  'Accept': 'application/vnd.github+json',
};

/* ============================================================
 * SHARED SIGNAL LOGIC — same function used by backtest.js.
 * Keep this deterministic and self-contained.
 * ============================================================ */
/**
 * @param {number} upside  e.g. 83.3
 * @param {number} volAmp  e.g. 93.3
 * @returns {{action,direction,conviction,size,edge,volRegime,riskFlag,rationale}}
 */
export function deriveSignal(upside, volAmp) {
  const u = Number(upside) || 50;
  const v = Number(volAmp) || 50;
  const edge = Math.abs(u - 50);

  // Tier from raw edge magnitude
  let tier;
  if      (edge >= 25) tier = 3;
  else if (edge >= 15) tier = 2;
  else if (edge >= 8)  tier = 1;
  else                 tier = 0;

  // Vol penalty — explosive regime knocks one tier off
  if (v >= 85) tier = Math.max(0, tier - 1);

  const baseDir   = u >= 50 ? 'LONG' : 'SHORT';
  const direction = tier === 0 ? 'NEUTRAL' : baseDir;
  const conviction = ['FLAT', 'WEAK', 'MODERATE', 'STRONG'][tier];
  const size = ['PASS', '¼ SIZE', '½ SIZE', 'FULL'][tier];

  // The vol gate: even if directional, if vol-amp is explosive AND we
  // didn't have a STRONG starting tier, downgrade to HOLD. This is the
  // "model is right but the path will chop you out" guard.
  let action;
  if (direction === 'NEUTRAL') {
    action = 'HOLD';
  } else if (v >= 85 && tier <= 1) {
    action = 'HOLD';                              // not worth fighting explosive vol on a thin edge
  } else if (direction === 'LONG') {
    action = 'BUY';
  } else {
    action = 'SELL';
  }

  let volRegime;
  if      (v >= 85) volRegime = 'EXPLOSIVE';
  else if (v >= 65) volRegime = 'ELEVATED';
  else if (v >= 40) volRegime = 'NORMAL';
  else              volRegime = 'COMPRESSED';

  const riskFlag = v >= 70;

  let rationale;
  if (action === 'HOLD' && direction === 'NEUTRAL') {
    rationale = `Edge (${edge.toFixed(0)} pts) is too thin to justify a directional trade. Stand aside.`;
  } else if (action === 'HOLD') {
    rationale = `Model is ${baseDir.toLowerCase()} (${u.toFixed(1)} % upside) but vol-amp ${v.toFixed(0)} % flags explosive 24h tape and edge is thin — hold cash until vol compresses.`;
  } else if (v >= 85) {
    rationale = `${conviction} ${baseDir.toLowerCase()} (${u.toFixed(1)} % upside) into explosive vol — size cut to ${size}, widen stop, expect chop on the way.`;
  } else if (v >= 70) {
    rationale = `${conviction} ${baseDir.toLowerCase()} (${u.toFixed(1)} % upside) with elevated vol regime — execute with discipline; don't add into adverse moves.`;
  } else {
    rationale = `${conviction} ${baseDir.toLowerCase()} bias (${u.toFixed(1)} % upside) on ${volRegime.toLowerCase()} vol — a clean setup if you take it.`;
  }

  return { action, direction, conviction, size, edge, volRegime, riskFlag, rationale };
}

/**
 * Compute entry/stop/target from spot + recent 1h klines.
 * Sized for a 24h hold, deterministic from the data:
 *   stop distance = max(2 × ATR_14, 1.5 % of spot)   — never tighter than 1.5 %
 *   if vol-amp elevated (≥70) →   widen by 50 % so stops survive an EXPLOSIVE day
 *   target distance = 2 × stop                       — R:R 1:2 across the board
 * For HOLD signals we still surface levels for context but mark them inactive.
 */
export function deriveLevels(spot, klines1h, action, volAmpPct) {
  if (!spot || !klines1h || klines1h.length < 15) return null;
  const last14 = klines1h.slice(-14);
  // True Range across the last 14 bars: max(high-low, |high-prevClose|, |low-prevClose|)
  let trSum = 0;
  for (let i = 0; i < last14.length; i++) {
    const k = last14[i];
    const high = +k[2], low = +k[3];
    const prevClose = i === 0
      ? +klines1h[klines1h.length - 15][4]
      : +last14[i - 1][4];
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trSum += tr;
  }
  const atr = trSum / last14.length;

  // Stop distance scaled by ATR with vol penalty
  const volElev = (Number(volAmpPct) || 0) >= 70;
  const baseStopDist = Math.max(atr * 2, spot * 0.015);
  const stopDist = volElev ? baseStopDist * 1.5 : baseStopDist;
  const targetDist = stopDist * 2;

  let stop, target;
  if (action === 'BUY') {
    stop   = spot - stopDist;
    target = spot + targetDist;
  } else if (action === 'SELL') {
    stop   = spot + stopDist;
    target = spot - targetDist;
  } else {
    // HOLD — symmetric guideposts so user can still gauge volatility envelope
    stop   = spot - stopDist;
    target = spot + targetDist;
  }

  return {
    entry: round2(spot),
    stop:  round2(stop),
    target: round2(target),
    atr1h: round2(atr),
    stopDistance: round2(stopDist),
    stopPct:   round2((stop - spot) / spot * 100),
    targetPct: round2((target - spot) / spot * 100),
    rrRatio: 2.0,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
const pct = (s) => Number(String(s ?? '').replace('%', ''));

/* ============================================================
 * UPSTREAM FETCHERS
 * ============================================================ */
const extract = (html, id) => {
  const re = new RegExp(`id="${id}"[^>]*>\\s*([^<]+?)\\s*<`, 'i');
  const m = html.match(re);
  return m ? m[1].trim() : null;
};

async function fetchKronosCurrent() {
  const r = await fetch(DEMO_URL, { headers: BROWSER_HEADERS, cache: 'no-store' });
  if (!r.ok) throw new Error(`demo upstream ${r.status}`);
  const html = await r.text();
  return {
    updatedAt: extract(html, 'update-time'),
    upsidePct: extract(html, 'upside-prob'),
    volAmpPct: extract(html, 'vol-amp-prob'),
  };
}

/** Fetch up to 168 hourly BTC/USDT klines from Binance public API. */
async function fetchKlines(limit = 48) {
  const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=${limit}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`binance ${r.status}`);
  return r.json();   // [[openTime, open, high, low, close, volume, ...], ...]
}

/** Fetch the BTC close price at a specific UTC millisecond timestamp (or the nearest 1h bar). */
async function fetchPriceAt(tsMs) {
  // Binance returns the bar whose openTime ≤ startTime
  const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${tsMs}&limit=1`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) return null;
  const arr = await r.json();
  if (!arr?.length) return null;
  return +arr[0][4]; // close
}

/** Find the Kronos-demo commit closest to (and after) `targetTsMs` and extract its forecast. */
async function fetchHistoricalForecast(targetTsMs, maxLookbackHours = 48) {
  const sinceIso = new Date(targetTsMs - 3 * 3600_000).toISOString();
  const untilIso = new Date(targetTsMs + 3 * 3600_000).toISOString();
  const r = await fetch(
    `${REPO_API_BASE}/commits?since=${sinceIso}&until=${untilIso}&per_page=10`,
    { headers: GH_HEADERS, cache: 'no-store' }
  );
  if (!r.ok) return null;
  const commits = await r.json();
  if (!commits?.length) return null;

  // Pick the one closest to target
  let best = null, bestDelta = Infinity;
  for (const c of commits) {
    const ts = new Date(c.commit?.committer?.date || c.commit?.author?.date || 0).getTime();
    const d = Math.abs(ts - targetTsMs);
    if (d < bestDelta) { bestDelta = d; best = c; }
  }
  if (!best) return null;
  if (bestDelta > maxLookbackHours * 3600_000) return null;

  const raw = await fetch(`${REPO_RAW_BASE}/${best.sha}/index.html`, { cache: 'no-store' });
  if (!raw.ok) return null;
  const html = await raw.text();
  return {
    sha: best.sha,
    committedAt: best.commit?.committer?.date,
    updatedAt: extract(html, 'update-time'),
    upsidePct: extract(html, 'upside-prob'),
    volAmpPct: extract(html, 'vol-amp-prob'),
  };
}

/* ============================================================
 * RECAP — "what did the model say 24h ago and what happened?"
 * ============================================================ */
async function buildRecap(klines, currentTsMs) {
  const targetTsMs = currentTsMs - 24 * 3600_000;
  const past = await fetchHistoricalForecast(targetTsMs);
  if (!past) return null;

  const pastUpside = pct(past.upsidePct);
  const pastVolAmp = pct(past.volAmpPct);
  const pastSignal = deriveSignal(pastUpside, pastVolAmp);

  // Price at the historical forecast vs now
  const pastTs = new Date(past.committedAt).getTime();
  const priceAt = await fetchPriceAt(pastTs);
  const priceNow = +klines[klines.length - 1][4];
  if (priceAt == null || priceNow == null) return null;

  const returnPct = (priceNow - priceAt) / priceAt * 100;
  let correct = null;
  if (pastSignal.action === 'BUY')  correct = returnPct > 0;
  if (pastSignal.action === 'SELL') correct = returnPct < 0;
  // HOLD has no directional bet → correctness undefined (treat as N/A)

  return {
    ts: past.updatedAt,
    upsidePct: past.upsidePct,
    volAmpPct: past.volAmpPct,
    signalAction: pastSignal.action,
    signalConviction: pastSignal.conviction,
    priceAt:  round2(priceAt),
    priceNow: round2(priceNow),
    returnPct: round2(returnPct),
    correct,
  };
}

/* ============================================================
 * HANDLERS
 * ============================================================ */
async function handleChart() {
  try {
    const r = await fetch(CHART_URL, { headers: BROWSER_HEADERS, cache: 'no-store' });
    if (!r.ok) return new Response(`Upstream ${r.status}`, { status: 502 });
    const buf = await r.arrayBuffer();
    return new Response(buf, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'access-control-allow-origin': '*',
        'cache-control': 'public, s-maxage=300, stale-while-revalidate=1800',
      },
    });
  } catch (e) {
    return new Response(`Chart fetch error: ${String(e?.message || e).slice(0, 200)}`, { status: 502 });
  }
}

async function handleJson(origin) {
  try {
    // Parallel: scrape the demo + pull 48 1h klines for ATR + 24h range
    const [current, klines] = await Promise.all([
      fetchKronosCurrent(),
      fetchKlines(48),
    ]);

    const upside = pct(current.upsidePct);
    const volAmp = pct(current.volAmpPct);
    const signal = deriveSignal(upside, volAmp);

    // Spot + 24h change from klines
    const lastBar = klines[klines.length - 1];
    const spot = +lastBar[4];
    const bar24hAgo = klines[klines.length - 25] || klines[0];
    const price24hAgo = +bar24hAgo[4];
    const chg24hPct = round2((spot - price24hAgo) / price24hAgo * 100);

    // 24h realized range (high-low over last 24 1h bars)
    const last24 = klines.slice(-24);
    const range24hHigh = Math.max(...last24.map((k) => +k[2]));
    const range24hLow  = Math.min(...last24.map((k) => +k[3]));
    const range24h = round2(range24hHigh - range24hLow);

    const levels = deriveLevels(spot, klines, signal.action, volAmp);

    // Last-24h recap — fire-and-forget; if GitHub is slow, the rest still ships
    let recap = null;
    try {
      recap = await Promise.race([
        buildRecap(klines, Date.now()),
        new Promise((_, rej) => setTimeout(() => rej(new Error('recap timeout')), 6000)),
      ]);
    } catch (e) {
      recap = null;
    }

    const payload = {
      ok: true,
      updatedAt: current.updatedAt,
      upsidePct: current.upsidePct,
      volAmpPct: current.volAmpPct,
      chartUrl: `${origin}/api/kronos?chart=1`,
      backtestUrl: `${origin}/api/kronos/backtest`,
      source: DEMO_URL,
      symbol: 'BTC/USDT',
      horizon: '24h',
      model: 'Kronos-mini · 4M params · MC N=30',
      spot: round2(spot),
      spot24hChg: chg24hPct,
      range24h,
      signal,
      levels,
      recap,
      fetchedAt: new Date().toISOString(),
    };

    return json(200, payload, /*sMaxAge*/ 300, /*swr*/ 1800);
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

export default async function handler(request) {
  const u = new URL(request.url);
  if (u.searchParams.get('chart') === '1') return handleChart();
  return handleJson(u.origin);
}
