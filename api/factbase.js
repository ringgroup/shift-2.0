/**
 * /api/factbase — Factbase CDN proxy.
 *
 * The official Roll Call Factbase site is paywalled BUT the underlying CDN
 * at media-cdn.factba.se publishes the full Trump calendar as a public JSON
 * feed. This function fetches that JSON server-side and converts it to RSS
 * so the existing parseRSS pipeline can consume it as a normal feed source.
 *
 * Only `calendar-full.json` is publicly accessible (the other paths —
 * transcripts/twitter/orders/etc — return 403).
 */

export const config = { runtime: 'edge' };

const CDN_URL = 'https://media-cdn.factba.se/rss/json/trump/calendar-full.json';

const escapeXml = (s) =>
  String(s || '').replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]));

export default async function handler(request) {
  try {
    const r = await fetch(CDN_URL, { cache: 'no-store' });
    if (!r.ok) {
      return new Response(`Upstream ${r.status}`, {
        status: 502, headers: { 'cache-control': 'no-store' },
      });
    }
    const items = await r.json();
    if (!Array.isArray(items)) {
      return new Response('Unexpected JSON shape', { status: 502 });
    }

    // Newest first
    items.sort((a, b) => {
      const ad = `${a.date || '0000-00-00'}T${a.time || '00:00:00'}`;
      const bd = `${b.date || '0000-00-00'}T${b.time || '00:00:00'}`;
      return bd.localeCompare(ad);
    });

    // Build RSS — keep up to 1000 entries (Factbase CDN typically returns
    // 30-60 days forward; pull everything available so we don't truncate).
    const rows = items.slice(0, 1000).map((it) => {
      const date = it.date || '';
      const time = it.time || '00:00:00';
      const isoStr = `${date}T${time}Z`;
      let pub = '';
      try { pub = new Date(isoStr).toUTCString(); } catch { pub = ''; }

      const title = `${(it.time_formatted || time).trim()} · ${(it.details || '').trim()}`;
      const url = it.url || `https://factba.se/topic/calendar?date=${date}`;
      const desc =
        [it.day_of_week, it.location, it.coverage, it.type]
          .filter(Boolean).join(' · ');

      return `<item>
  <title><![CDATA[${title}]]></title>
  <link>${escapeXml(url)}</link>
  <pubDate>${pub}</pubDate>
  <description><![CDATA[${desc}]]></description>
  <guid isPermaLink="false">factbase-${escapeXml(date)}-${escapeXml(time)}</guid>
</item>`;
    }).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>Factbase · Trump Calendar (CDN)</title>
<link>https://factba.se/topic/calendar</link>
<description>Public Factbase JSON CDN — full presidential schedule.</description>
<atom:link href="${escapeXml(new URL(request.url).origin + '/api/factbase')}" rel="self" type="application/rss+xml" />
${rows}
</channel>
</rss>`;

    return new Response(xml, {
      status: 200,
      headers: {
        'content-type': 'application/rss+xml; charset=utf-8',
        'cache-control': 'public, s-maxage=300, stale-while-revalidate=1800',
        'access-control-allow-origin': '*',
      },
    });
  } catch (e) {
    return new Response(`Error: ${String(e?.message || e).slice(0, 200)}`, {
      status: 500, headers: { 'cache-control': 'no-store' },
    });
  }
}
