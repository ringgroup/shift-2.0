/**
 * /api/kronos — proxy + parser for the public Kronos forecast demo.
 *
 * Kronos (https://github.com/shiyu-coder/Kronos) is an open-source foundation
 * model for financial K-line forecasting. The maintainer auto-publishes a live
 * BTC/USDT 1h forecast at https://shiyu-coder.github.io/Kronos-demo/ — a static
 * page regenerated hourly by a cron in the Kronos-demo repo.
 *
 * The page is static (no JSON API) and CORS-restricted for the chart image.
 * This endpoint fetches the page server-side, pulls out the three values we
 * actually want (timestamp, upside prob, vol-amp prob), and proxies the chart
 * PNG too so the browser can render everything from one origin.
 *
 * Usage:
 *   GET /api/kronos           → JSON  { updatedAt, upsidePct, volAmpPct, chartUrl, source }
 *   GET /api/kronos?chart=1   → the PNG chart, edge-cached
 *
 * Edge-cached 5 min fresh + 30 min stale. The upstream regenerates hourly so
 * 5 min is plenty fresh; the SWR keeps the panel responsive if their CI lags.
 */

export const config = { runtime: 'edge' };

const DEMO_URL  = 'https://shiyu-coder.github.io/Kronos-demo/';
const CHART_URL = 'https://shiyu-coder.github.io/Kronos-demo/prediction_chart.png';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/png,*/*;q=0.5',
  'Accept-Language': 'en-US,en;q=0.9',
};

const extract = (html, id) => {
  // <p class="metric-value" id="upside-prob">83.3%</p>
  const re = new RegExp(`id="${id}"[^>]*>\\s*([^<]+?)\\s*<`, 'i');
  const m = html.match(re);
  return m ? m[1].trim() : null;
};

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
        // chart regenerates hourly upstream — 5 min fresh + 30 min stale
        'cache-control': 'public, s-maxage=300, stale-while-revalidate=1800',
      },
    });
  } catch (e) {
    return new Response(`Chart fetch error: ${String(e?.message || e).slice(0, 200)}`, { status: 502 });
  }
}

async function handleJson(origin) {
  try {
    const r = await fetch(DEMO_URL, { headers: BROWSER_HEADERS, cache: 'no-store' });
    if (!r.ok) {
      return json(502, { ok: false, error: `Upstream ${r.status}` });
    }
    const html = await r.text();

    const updatedAt = extract(html, 'update-time');   // "2026-06-02 15:00:25"
    const upsidePct = extract(html, 'upside-prob');   // "83.3%"
    const volAmpPct = extract(html, 'vol-amp-prob');  // "93.3%"

    const payload = {
      ok: true,
      updatedAt,         // server's UTC string, as displayed
      upsidePct,         // e.g. "83.3%"
      volAmpPct,         // e.g. "93.3%"
      // Use our own proxy URL so the client gets a same-origin cached PNG and
      // doesn't burn the user's bandwidth/cache on github.io directly.
      chartUrl: `${origin}/api/kronos?chart=1`,
      source: DEMO_URL,
      symbol: 'BTC/USDT',
      horizon: '24h',
      model: 'Kronos-mini · 4M params · MC N=30',
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
