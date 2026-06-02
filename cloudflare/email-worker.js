/**
 * SHIFT inbound-email worker (Cloudflare Email Workers).
 *
 * Trigger: any email landing on intel@ringlabs.dev (or whatever address
 * Cloudflare Email Routing forwards here).
 *
 * Pipeline:
 *   1. Parse raw MIME with postal-mime
 *   2. POST a normalized JSON payload to SHIFT's /api/inbox endpoint
 *   3. SHIFT stores it in Upstash + exposes it as RSS for the news deck
 *
 * Env vars (set via `wrangler secret put` or the CF dashboard):
 *   INGEST_URL        e.g. https://shift-2-0.vercel.app/api/inbox
 *   INGEST_SECRET     same value as INBOX_SECRET in Vercel
 *
 * Wrangler setup:
 *   npm i -g wrangler
 *   wrangler init shift-inbox-worker
 *   # paste this file as src/index.js, then:
 *   npm i postal-mime
 *   wrangler secret put INGEST_URL
 *   wrangler secret put INGEST_SECRET
 *   wrangler deploy
 *
 * Then in the Cloudflare dashboard:
 *   Email → Email Routing → Routes → Create address `intel@ringlabs.dev`
 *   Action: "Send to a Worker" → pick shift-inbox-worker
 */

import PostalMime from 'postal-mime';

export default {
  async email(message, env, ctx) {
    try {
      const parser = new PostalMime();
      const parsed = await parser.parse(message.raw);

      const body = {
        from: parsed.from?.address || 'unknown@unknown',
        fromName: parsed.from?.name || (parsed.from?.address || '').split('@')[0],
        subject: parsed.subject || '(no subject)',
        date: parsed.date || new Date().toISOString(),
        html: parsed.html || '',
        text: parsed.text || '',
        messageId: parsed.messageId || '',
        to: (parsed.to || []).map((t) => t.address),
      };

      const r = await fetch(env.INGEST_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.INGEST_SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!r.ok) {
        // Log to CF tail for debugging; don't block the email pipeline
        console.error('SHIFT ingest failed', r.status, await r.text());
      }
    } catch (e) {
      console.error('SHIFT worker error', e?.message || e);
      // Don't reject — once a message is rejected from a worker, the sender
      // gets a bounce. Better to silently swallow and let us debug in tail.
    }
  },
};
