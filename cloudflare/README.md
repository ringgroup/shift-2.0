# SHIFT inbound-email pipeline

Receives email at `intel@ringlabs.dev`, parses it, and exposes it as RSS at
`/api/inbox` so it flows into the SHIFT news deck like any other source.

```
sender → MX → Cloudflare Email Routing → Email Worker
       → POST https://shift-2-0.vercel.app/api/inbox (Bearer INBOX_SECRET)
       → Upstash Redis (sorted set, 500-item cap)
       → GET /api/inbox  (renders RSS)
```

## One-time setup

### 1. Provision storage — Upstash Redis on Vercel Marketplace
```
Vercel dashboard → Storage → Marketplace → Upstash for Redis → Add
```
Pick the free plan (10k commands/day is plenty for newsletter volume).
This auto-injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` into the
SHIFT project's env vars.

### 2. Generate the shared secret
```bash
INBOX_SECRET=$(openssl rand -base64 32 | tr -d /=+ | head -c 40)
echo "$INBOX_SECRET"
```
Add to **Vercel** (Settings → Env Vars):
```
INBOX_SECRET=<value>
```

### 3. Add MX records to ringlabs.dev
Cloudflare → ringlabs.dev → DNS → add the three MX records Cloudflare
provides for Email Routing (route24.mx.cloudflare.net etc).

### 4. Enable Email Routing
Cloudflare → ringlabs.dev → Email → Email Routing → Enable.

### 5. Deploy the worker
```bash
cd cloudflare
npm i -g wrangler
npm init -y
npm i postal-mime
wrangler login
wrangler secret put INGEST_URL    # paste: https://shift-2-0.vercel.app/api/inbox
wrangler secret put INGEST_SECRET # paste: same value as Vercel INBOX_SECRET
wrangler deploy
```

### 6. Route intel@ringlabs.dev → worker
Cloudflare → Email Routing → Routes → Create address:
- Address: `intel@ringlabs.dev`
- Action: **Send to a Worker** → pick `shift-inbox-worker`

### 7. Test it
Send an email from anywhere to `intel@ringlabs.dev`. Within ~5s:
```bash
curl -s https://shift-2-0.vercel.app/api/inbox | head -50
```
You should see your email rendered as an RSS item.

## Subscribing to newsletters

Once the pipeline works, point any newsletter / mailing list at
`intel@ringlabs.dev`. Examples:

- GovDelivery topics — fill in the subscribe form on agency websites
- Substacks — sign up via web on the publication's page
- Analyst lists — request to join with `intel@ringlabs.dev`

The INBOX source in SHIFT will pick them up next time the news cron runs
(every 10 min, edge-cached 60s on the feed endpoint).

## Operational notes

- **Cap**: 500 most-recent items retained. Older items are pruned by the
  `ZREMRANGEBYRANK` call in the ingest path.
- **Tracking pixels & footers**: stripped server-side before storage
  (see `sanitizeBody()` in `/api/inbox.js`).
- **Worker debugging**: `wrangler tail shift-inbox-worker` shows real-time
  logs of each email arrival + the resulting POST status.
- **Failure mode**: if the ingest POST fails, the worker logs and silently
  swallows (no bounce to sender). Re-deploy after fixing the env vars.
