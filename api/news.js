/**
 * /api/news — server-side RSS proxy.
 *
 * The 'many credible regional outlets show 0 items' problem is caused by:
 *   - Public CORS proxies (allorigins / codetabs / corsproxy) intermittently
 *     returning HTML challenge pages instead of the actual RSS
 *   - Sources with bot detection blocking those proxy IPs
 *   - Some publishers serving 403 to known CORS proxies
 *
 * This function fetches the RSS server-side with a real browser User-Agent
 * and returns the raw body. Edge-cached 5 min fresh + 30 min stale-while-
 * revalidate per URL, so each unique feed is hit upstream at most ~12x/hour
 * regardless of how many users open the dashboard.
 *
 * Usage: /api/news?url=<encoded-rss-url>
 */

export const config = { runtime: 'edge' };

/* Cheap allowlist guard — only proxy hosts that look like news/RSS sources.
 * Stops the endpoint from being used as a general open proxy. */
const ALLOW_HOST = /(?:\.com|\.org|\.net|\.gov|\.int|\.mil|\.edu|\.ae|\.sa|\.il|\.qa|\.bh|\.kw|\.om|\.eg|\.ir|\.lb|\.tr|\.de|\.fr|\.uk|\.us|\.io|\.ai|\.co|\.news|\.tv|\.app|\.dev|\.se|\.eu|\.in|\.jp|\.kr|\.cn|\.sg|\.au|\.ca|\.ru|\.za|\.info)$/i;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

/**
 * Per-host cache TTL override (seconds at the edge). Most feeds run on the
 * default 5min fresh / 30min stale — but DVIDS pushes ~20 stateside items
 * per day and we only want to hit upstream twice a day, so 12h fresh + 12h
 * stale lets the cron try every 10min but only refetch when the cache window
 * expires.
 */
function cacheTtlFor(parsedUrl) {
  if (parsedUrl.hostname.endsWith('dvidshub.net')) {
    return { sMaxAge: 12 * 3600, swr: 12 * 3600 };
  }
  return { sMaxAge: 300, swr: 1800 };
}

/**
 * Per-host header override. Reddit's ToS requires a uniquely-identifying UA
 * in '<platform>:<app>:<version> (by /u/<user>)' format — Mozilla strings
 * get 429'd from datacenter IPs. RSSHub instances expect a project UA.
 */
function headersFor(parsedUrl) {
  const host = parsedUrl.hostname;
  if (host.endsWith('reddit.com')) {
    return {
      'User-Agent': 'web:shift-2.0-intel-terminal:v2.0 (by /u/anon)',
      'Accept': 'application/atom+xml, application/xml;q=0.9, */*;q=0.5',
    };
  }
  if (host.endsWith('rsshub.app') || host.endsWith('rsshub.pseudoyu.com')) {
    return { 'User-Agent': 'shift-2.0/2.0 (+https://shift-2-0.vercel.app)' };
  }
  // Roll Call Factbase is paywalled — pass through the subscriber's cookie
  // if ROLLCALL_COOKIE env var is set so the upstream sees an auth'd session.
  if (host.endsWith('rollcall.com') || host.endsWith('factba.se')) {
    const cookie = (typeof process !== 'undefined' && process.env?.ROLLCALL_COOKIE) || '';
    if (cookie) {
      return { ...BROWSER_HEADERS, Cookie: cookie };
    }
  }
  return BROWSER_HEADERS;
}

export default async function handler(request) {
  const u = new URL(request.url);
  const target = u.searchParams.get('url');
  if (!target) {
    return new Response('Missing ?url=', { status: 400 });
  }

  let parsed;
  try { parsed = new URL(target); } catch { return new Response('Bad URL', { status: 400 }); }
  if (!/^https?:$/.test(parsed.protocol)) {
    return new Response('Only http(s)', { status: 400 });
  }
  if (!ALLOW_HOST.test(parsed.hostname)) {
    return new Response('Host not allowed', { status: 403 });
  }

  try {
    let r = await fetch(parsed.toString(), {
      headers: headersFor(parsed),
      cache: 'no-store',
      redirect: 'follow',
    });
    // Retry once on 429/503 with the generic browser headers (in case the
    // per-host UA is the thing being rate-limited).
    if (r.status === 429 || r.status === 503) {
      await new Promise((rs) => setTimeout(rs, 1200));
      r = await fetch(parsed.toString(), {
        headers: BROWSER_HEADERS,
        cache: 'no-store',
        redirect: 'follow',
      });
    }
    if (!r.ok) {
      return new Response(`Upstream ${r.status}`, {
        status: 502,
        headers: { 'cache-control': 'no-store' },
      });
    }
    const text = await r.text();
    const ct = r.headers.get('content-type') || 'application/xml; charset=utf-8';
    const { sMaxAge, swr } = cacheTtlFor(parsed);
    return new Response(text, {
      status: 200,
      headers: {
        'content-type': ct,
        'access-control-allow-origin': '*',
        // Default 5min fresh + 30min stale; per-host override above for
        // low-velocity sources we only want to refetch twice a day.
        'cache-control': `public, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`,
      },
    });
  } catch (e) {
    return new Response(`Fetch error: ${String(e?.message || e).slice(0, 200)}`, {
      status: 502,
      headers: { 'cache-control': 'no-store' },
    });
  }
}
