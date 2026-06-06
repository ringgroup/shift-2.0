/**
 * /api/cron/scrape — Vercel Pro cron job.
 *
 * Runs every 10 minutes (configured in vercel.json). Pings the /api/news
 * proxy for every known feed URL so the edge cache stays warm. When users
 * open the dashboard, the news deck is already populated — no waterfall
 * of 30+ slow upstream fetches.
 *
 * Auth: same `Authorization: Bearer <CRON_SECRET>` pattern.
 */

export const config = { runtime: 'edge' };

const FEED_URLS = [
  // Regional / MENA
  'https://www.aljazeera.com/xml/rss/all.xml',
  'https://www.timesofisrael.com/feed/',
  'https://www.jpost.com/rss/rssfeedsfrontpage.aspx',
  'https://www.ynetnews.com/Integration/StoryRss3082.xml',
  'https://www.haaretz.com/srv/htz-rss-eng',
  'https://www.israelhayom.com/feed/',
  'https://www.israelnationalnews.com/Rss.aspx',
  'https://www.thenationalnews.com/rss/uae',
  'https://www.thenationalnews.com/rss/mena',
  'https://www.arabnews.com/rss.xml',
  'https://www.khaleejtimes.com/rss',
  'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml',
  'https://www.alarabiya.net/.mrss/ar.xml',
  // US wires
  'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
  'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',
  'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',
  'https://feeds.a.dj.com/rss/RSSWorldNews.xml',
  'http://rss.cnn.com/rss/cnn_topstories.rss',
  'http://rss.cnn.com/rss/cnn_world.rss',
  'https://api.axios.com/feed/',
  // Multilateral
  'https://www.who.int/rss-feeds/news-english.xml',
  'https://news.un.org/feed/subscribe/en/news/all/rss.xml',
  // Defense / analysis
  'https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945&max=20',
  'https://thediplomat.com/feed/',
  // Reddit
  'https://www.reddit.com/r/worldnews/.rss?limit=25',
  'https://www.reddit.com/r/MiddleEastNews/.rss?limit=25',
  'https://www.reddit.com/r/geopolitics/.rss?limit=25',
  'https://www.reddit.com/r/syriancivilwar/.rss?limit=25',
  // AI / tech
  'https://techcrunch.com/category/artificial-intelligence/feed/',
  'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
  'https://www.technologyreview.com/feed/',
  // UAE official
  'https://moi.gov.ae/en/rss/rss.aspx',
  'https://moi.gov.ae/ar/rss/rss.aspx',
  'https://news.google.com/rss/search?q=site:moi.gov.ae+OR+%22Ministry+of+Interior%22+UAE&when:2d&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=site:timesofisrael.com&when:1d&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=site:thenationalnews.com&when:1d&hl=en-US&gl=US&ceid=US:en',
  'https://www.youtube.com/feeds/videos.xml?channel_id=UCMebk44F_zVLj-7aD_mSUhQ',
  'https://www.youtube.com/feeds/videos.xml?channel_id=UCLqu78o49yHSQTOUEWh_8Vg',
  // US government
  'https://www.whitehouse.gov/feed/',
  'https://news.google.com/rss/search?q=site:state.gov&when:2d&hl=en-US&gl=US&ceid=US:en',
  'https://www.war.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945&max=20',
  'https://www.dvidshub.net/rss/news',
  'https://www.dvidshub.net/rss/image',
  'https://www.energy.gov/rss.xml',
  'https://news.google.com/rss/search?q=site:energy.gov&when:2d&hl=en-US&gl=US&ceid=US:en',
  'https://www.justice.gov/feeds/justice-news.xml',
  'https://news.google.com/rss/search?q=site:justice.gov&when:2d&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=%22OFAC%22+OR+%22Office+of+Foreign+Assets+Control%22+sanctions+OR+designation&when:3d&hl=en-US&gl=US&ceid=US:en',
  // Treasury GovDelivery — press releases + master SDN + per-country programs
  'https://public.govdelivery.com/topics/USTREAS_49/feed.rss',
  'https://public.govdelivery.com/topics/USTREAS_89/feed.rss',
  'https://public.govdelivery.com/topics/USTREAS_94/feed.rss',
  'https://public.govdelivery.com/topics/USTREAS_91/feed.rss',
  'https://public.govdelivery.com/topics/USTREAS_120/feed.rss',
  'https://public.govdelivery.com/topics/USTREAS_121/feed.rss',
  'https://public.govdelivery.com/topics/USTREAS_125/feed.rss',
  'https://public.govdelivery.com/topics/USTREAS_128/feed.rss',
  'https://public.govdelivery.com/topics/USTREAS_123/feed.rss',
  'https://public.govdelivery.com/topics/USTREAS_124/feed.rss',
  'https://www.senate.gov/legislative/LIS/roll_call_lists/votes_new.xml',
  'https://rollcall.com/feed/',
];

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
  const t0 = Date.now();

  // Fire all in parallel but cap concurrency to avoid burning function time
  const BATCH = 8;
  const buckets = [];
  for (let i = 0; i < FEED_URLS.length; i += BATCH) {
    buckets.push(FEED_URLS.slice(i, i + BATCH));
  }

  const status = { warm: 0, fail: 0, total: FEED_URLS.length };
  for (const bucket of buckets) {
    await Promise.allSettled(
      bucket.map(async (feed) => {
        try {
          const r = await fetch(`${origin}/api/news?url=${encodeURIComponent(feed)}`, { cache: 'no-store' });
          if (r.ok) status.warm++;
          else status.fail++;
        } catch { status.fail++; }
      })
    );
  }

  return json(200, {
    ok: true,
    at: new Date().toISOString(),
    durationMs: Date.now() - t0,
    ...status,
  });
}
