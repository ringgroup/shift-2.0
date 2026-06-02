/**
 * /api/cron/kronos-trend — once-a-day warm of the 7-day trend endpoint.
 *
 * /api/kronos/trend is expensive (160 raw HTML fetches + Binance + GitHub)
 * so we don't include it in the every-5-min refresh cron. This cron runs
 * once a day at 06:00 UTC to recompute the trend and seed the edge cache
 * so the next user hit is instant.
 *
 * Auth: standard Vercel Cron `Authorization: Bearer <CRON_SECRET>`.
 */

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization') || '';
    if (auth !== `Bearer ${secret}`) {
      return new Response(JSON.stringify({ ok: false, error: 'cron unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
  }

  const origin = new URL(request.url).origin;
  const t0 = Date.now();
  try {
    const r = await fetch(`${origin}/api/kronos/trend?days=7`, { cache: 'no-store' });
    const body = await r.text();
    return new Response(JSON.stringify({
      ok: true,
      at: new Date().toISOString(),
      durationMs: Date.now() - t0,
      upstreamStatus: r.status,
      upstreamBytes: body.length,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false, error: String(e?.message || e).slice(0, 200),
    }), { status: 502, headers: { 'content-type': 'application/json' } });
  }
}
