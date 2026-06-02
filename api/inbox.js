/**
 * /api/inbox — inbound email pipeline.
 *
 * Architecture:
 *   intel@ringlabs.dev
 *     → Cloudflare Email Routing
 *     → Cloudflare Email Worker (parses MIME, POSTs JSON here)
 *     → POST /api/inbox  (this endpoint, with Bearer INBOX_SECRET)
 *     → Upstash Redis (sorted set indexed by timestamp, cap 500)
 *     → GET /api/inbox  (this endpoint, public via middleware gate)
 *     → returns RSS  → SHIFT parses like any other source
 *
 * Storage:
 *   - inbox:index            sorted set, score=unix-ms, member=item-id
 *   - inbox:item:<id>        JSON-stringified item
 *
 * Setup:
 *   See /cloudflare/README.md for DNS / Worker / Upstash provisioning.
 *
 * Env vars (production):
 *   INBOX_SECRET        — shared secret the Email Worker uses on POST
 *   KV_REST_API_URL     — Upstash REST URL (auto-set by Vercel Marketplace
 *                         when you add Upstash Redis to the project)
 *   KV_REST_API_TOKEN   — Upstash REST token (same)
 */

export const config = { runtime: 'edge' };

const KV_URL   = (typeof process !== 'undefined' && process.env?.KV_REST_API_URL)   || '';
const KV_TOKEN = (typeof process !== 'undefined' && process.env?.KV_REST_API_TOKEN) || '';
const INBOX_SECRET = (typeof process !== 'undefined' && process.env?.INBOX_SECRET)  || '';

const MAX_ITEMS = 500; // ring-buffer cap
const FEED_LIMIT = 100; // most-recent items rendered to RSS

/* ============ tiny Upstash REST helpers ============ */
async function kv(cmd) {
  // cmd = ['ZADD', 'inbox:index', '1700000000000', 'abc123']  etc.
  const r = await fetch(`${KV_URL}/${cmd.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) throw new Error(`KV ${cmd[0]} ${r.status}: ${await r.text()}`);
  return (await r.json()).result;
}
async function kvPipeline(cmds) {
  const r = await fetch(`${KV_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error(`KV pipeline ${r.status}: ${await r.text()}`);
  return (await r.json()).map((x) => x.result);
}

/* ============ helpers ============ */
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Pull the canonical "view this email online" URL that nearly every newsletter
 * platform (GovDelivery, Mailchimp, Substack) puts at the top. Falls back to
 * the first external link in the body, then to a placeholder.
 */
function deriveLink(html, text) {
  const body = String(html || text || '');
  // Look for "view as a webpage", "view online", "view in browser" near a link
  const viewMatch = body.match(/<a[^>]+href="(https?:[^"]+)"[^>]*>[^<]*(view (this )?(email )?(online|in (your )?browser|as (a )?web ?page))/i);
  if (viewMatch) return viewMatch[1];
  // First external link
  const linkMatch = body.match(/<a[^>]+href="(https?:\/\/[^"]+)"/);
  if (linkMatch) return linkMatch[1];
  return 'https://shift-2-0.vercel.app/';
}

/**
 * Strip unsubscribe footer / tracking pixels from email HTML before storage.
 * Best-effort — don't be too aggressive, just drop the obvious garbage.
 */
function sanitizeBody(html) {
  if (!html) return '';
  return String(html)
    // 1px tracking gifs
    .replace(/<img[^>]+(?:width="1"|height="1")[^>]*>/gi, '')
    // GovDelivery footer (everything from "Manage your subscriptions" down)
    .replace(/(<table[^>]*>\s*<tbody[^>]*>\s*<tr[^>]*>\s*<td[^>]*>[^<]*(Manage (your )?Subscriptions?|Unsubscribe|Privacy Policy)[\s\S]*$)/i, '')
    // Mailchimp-style unsubscribe block
    .replace(/(<div[^>]*>[^<]*unsubscribe[\s\S]{0,2000}<\/div>)/i, '');
}

/* ============ POST: ingest one email from the Worker ============ */
async function handleIngest(request) {
  if (!INBOX_SECRET) return json(503, { ok: false, error: 'INBOX_SECRET not configured' });
  const auth = request.headers.get('authorization') || '';
  if (auth !== `Bearer ${INBOX_SECRET}`) {
    return json(401, { ok: false, error: 'unauthorized' });
  }
  if (!KV_URL || !KV_TOKEN) return json(503, { ok: false, error: 'KV not configured' });

  let payload;
  try { payload = await request.json(); }
  catch { return json(400, { ok: false, error: 'bad json' }); }

  const subject = String(payload.subject || '(no subject)').slice(0, 500);
  const from    = String(payload.from    || 'unknown@unknown').slice(0, 200);
  const fromName= String(payload.fromName|| from.split('@')[0]).slice(0, 100);
  const date    = payload.date ? new Date(payload.date) : new Date();
  const html    = sanitizeBody(payload.html || '');
  const text    = String(payload.text || '').slice(0, 50_000);
  const msgId   = String(payload.messageId || '').slice(0, 200);

  // Stable ID: prefer Message-ID, fall back to hash of from+subject+date
  const id = (msgId
    ? await sha256Hex(msgId)
    : await sha256Hex(`${from}|${subject}|${date.toISOString().slice(0, 16)}`)
  ).slice(0, 16);

  const item = {
    id,
    from,
    fromName,
    subject,
    date: date.toISOString(),
    link: deriveLink(html, text),
    html: html.slice(0, 200_000), // hard cap
    text: text.slice(0, 50_000),
    receivedAt: new Date().toISOString(),
  };

  // Single pipelined write: SET item + ZADD index + ZREMRANGEBYRANK to trim
  await kvPipeline([
    ['SET', `inbox:item:${id}`, JSON.stringify(item)],
    ['ZADD', 'inbox:index', date.getTime(), id],
    ['ZREMRANGEBYRANK', 'inbox:index', 0, -MAX_ITEMS - 1],
  ]);

  return json(200, { ok: true, id, subject });
}

/* ============ GET: render stored emails as RSS ============ */
async function handleFeed() {
  if (!KV_URL || !KV_TOKEN) {
    // Graceful empty feed if storage isn't wired up yet — parses cleanly
    return rss('SHIFT // INBOX', []);
  }

  // Most-recent first
  const ids = await kv(['ZRANGE', 'inbox:index', '0', String(FEED_LIMIT - 1), 'REV']);
  if (!ids || !ids.length) return rss('SHIFT // INBOX', []);

  // MGET all items in one round-trip
  const raws = await kv(['MGET', ...ids.map((id) => `inbox:item:${id}`)]);
  const items = (raws || []).filter(Boolean).map((s) => {
    try { return JSON.parse(s); } catch { return null; }
  }).filter(Boolean);

  return rss('SHIFT // INBOX', items);
}

function rss(title, items) {
  const now = new Date().toUTCString();
  const xmlItems = items.map((it) => {
    const pub = new Date(it.date).toUTCString();
    const desc = it.html || it.text || '';
    return `
    <item>
      <title>${esc(`[${it.fromName}] ${it.subject}`)}</title>
      <link>${esc(it.link)}</link>
      <guid isPermaLink="false">${esc(it.id)}</guid>
      <pubDate>${pub}</pubDate>
      <description><![CDATA[${desc}]]></description>
      <source url="mailto:${esc(it.from)}">${esc(it.fromName)}</source>
    </item>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${esc(title)}</title>
  <link>https://shift-2-0.vercel.app/</link>
  <description>Inbound newsletters routed through ringlabs.dev</description>
  <lastBuildDate>${now}</lastBuildDate>
  ${xmlItems}
</channel>
</rss>`;

  return new Response(xml, {
    status: 200,
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, s-maxage=60, stale-while-revalidate=300',
    },
  });
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/* ============ dispatch ============ */
export default async function handler(request) {
  if (request.method === 'POST') return handleIngest(request);
  if (request.method === 'GET')  return handleFeed();
  return json(405, { ok: false, error: 'method not allowed' });
}
