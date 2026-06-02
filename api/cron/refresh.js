/**
 * /api/cron/refresh — Vercel Pro cron job.
 *
 * Scheduled in vercel.json to run every 5 minutes. Pings all of our data
 * endpoints so the edge cache stays warm — when a user opens the dashboard,
 * markets / aircraft / oil / fx are already in cache.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically
 * if CRON_SECRET is set in the project env. We verify it to block public
 * abuse of the endpoint.
 */

export const config = { runtime: 'edge' };

const json = (status, payload) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

export default async function handler(request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization') || '';
    if (auth !== `Bearer ${secret}`) {
      return json(401, { ok: false, error: 'cron unauthorized' });
    }
  }

  const origin = new URL(request.url).origin;
  const targets = [
    `${origin}/api/markets`,
    `${origin}/api/fx`,
    `${origin}/api/oil`,
    `${origin}/api/aircraft?preset=uae`,
    `${origin}/api/aircraft?preset=hormuz`,
    `${origin}/api/aircraft?preset=mena`,
    `${origin}/api/factbase`,
    `${origin}/api/kronos`,
    `${origin}/api/kronos/backtest`,
  ];

  const t0 = Date.now();
  const results = await Promise.allSettled(
    targets.map(async (u) => {
      const r = await fetch(u, { cache: 'no-store' });
      return { url: u, status: r.status, size: (await r.text()).length };
    })
  );

  return json(200, {
    ok: true,
    at: new Date().toISOString(),
    durationMs: Date.now() - t0,
    results: results.map((r, i) => ({
      target: targets[i],
      ...(r.status === 'fulfilled' ? r.value : { error: String(r.reason?.message || r.reason) }),
    })),
  });
}
