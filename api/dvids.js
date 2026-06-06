/**
 * /api/dvids — CENTCOM-filtered DVIDS feed.
 *
 * The DVIDS firehose (/rss/news/all and /rss/image/all) carries 400+ items
 * per query but nearly all are stateside National Guard / Naval training /
 * domestic Coast Guard. Their search RSS is broken — q=CENTCOM returns the
 * same items as q=Iran (we tested). So we filter ourselves.
 *
 * The filter is strict-but-narrow: high-precision MENA / CENTCOM keywords,
 * with an exclusion list to drop AFRICOM / EUCOM look-alikes (EURAFCENT,
 * Sigonella, Naples, Aviano, etc.). The output is a synthesized RSS that
 * parseRSS on the client consumes like any other source — same item shape,
 * same image extraction, same dedupe.
 *
 * Usage:
 *   GET /api/dvids                → news, CENTCOM-filtered
 *   GET /api/dvids?type=image     → imagery, CENTCOM-filtered
 *   GET /api/dvids?type=news      → explicit news
 *
 * Edge-cached 12 h fresh + 12 h stale (twice-daily refresh, matches the
 * per-host TTL we set on /api/news for the unfiltered firehose).
 */

export const config = { runtime: 'edge' };

/** CENTCOM-relevant terms. Anchored on word boundaries; case-insensitive. */
const INCLUDE = new RegExp([
  // Command + sub-commands
  '\\bUSCENTCOM\\b', '\\bCENTCOM\\b', '\\bU\\.S\\. Central Command\\b',
  '\\bMARCENT\\b', '\\bAFCENT\\b', '\\bARCENT\\b', '\\bNAVCENT\\b',
  '\\bUSNAVCENT\\b', '\\bSOCCENT\\b', '\\bUSAFCENT\\b',
  // Naval — 5th Fleet is the AOR-specific Navy fleet
  '\\b5th Fleet\\b', '\\bU\\.S\\. 5th Fleet\\b', '\\bFifth Fleet\\b',
  // Geography — only unambiguously-MENA waterway names
  '\\bPersian Gulf\\b', '\\bArabian Gulf\\b', '\\bArabian Sea\\b',
  '\\bStrait of Hormuz\\b', '\\bBab el[- ]Mandeb\\b', '\\bRed Sea\\b',
  '\\bSuez\\b',
  // Countries (MENA)
  '\\bIran\\b', '\\bIranian\\b',
  '\\bIraq\\b', '\\bIraqi\\b',
  '\\bSyria\\b', '\\bSyrian\\b',
  '\\bYemen\\b', '\\bYemeni\\b',
  '\\bLebanon\\b', '\\bLebanese\\b',
  '\\bBahrain\\b', '\\bQatar\\b',
  '\\bUnited Arab Emirates\\b', '\\bU\\.A\\.E\\b', '\\bUAE\\b',
  '\\bSaudi Arabia\\b', '\\bSaudi\\b',
  '\\bKuwait\\b', '\\bOman\\b', '\\bJordan\\b', '\\bEgypt\\b',
  '\\bAfghanistan\\b', '\\bAfghan\\b',
  // Threats / groups
  '\\bHouthi\\b', '\\bHezbollah\\b', '\\bHamas\\b',
  '\\bIRGC\\b', '\\bISIS\\b', '\\bISIL\\b', '\\bDaesh\\b',
  // Operations
  '\\bInherent Resolve\\b', '\\bProsperity Guardian\\b',
  '\\bRough Rider\\b', '\\bRough Phoenix\\b',
  // Forward bases
  '\\bAl Udeid\\b', '\\bAl Dhafra\\b', '\\bCamp Arifjan\\b',
  '\\bCamp Buehring\\b', '\\bNSA Bahrain\\b', '\\bManama\\b',
].join('|'), 'i');

/** Exclusion patterns — kill obvious false positives that share keywords
 *  with our MENA list. EURAFCENT / Naples / Sigonella / Aviano are
 *  Europe-Africa Command, not CENTCOM. "Gulf Coast" = Florida.
 *  "Gulf of Mexico" = obvious. */
const EXCLUDE = new RegExp([
  '\\bEURAFCENT\\b', '\\bEUCOM\\b', '\\bAFRICOM\\b',
  '\\bNaples\\b', '\\bSigonella\\b', '\\bAviano\\b', '\\bSpangdahlem\\b',
  '\\bRamstein\\b', '\\bGrafenw[oö]hr\\b',
  '\\bGulf of Mexico\\b', '\\bGulf Coast\\b',
  '\\bGulf Stream\\b',
  // African Lion is the AFRICOM annual exercise — keyword "African Lion"
  '\\bAfrican Lion\\b',
].join('|'), 'i');

const UPSTREAM = {
  news:  'https://www.dvidshub.net/rss/news/all',
  image: 'https://www.dvidshub.net/rss/image/all',
};

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5',
};

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Naïve item splitter — DVIDS items are well-formed and there's no nesting
 *  weirdness here (no item-in-item, no CDATA containing </item>). */
function splitItems(xml) {
  const out = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function pickFirst(itemXml, ...tagNames) {
  for (const tag of tagNames) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const m = itemXml.match(re);
    if (m) return m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
  }
  return '';
}

/** Decide whether to keep an item. Match against title + description. */
function keepItem(itemXml) {
  // Strip CDATA + HTML tags before matching so we don't get bogus matches
  // from URL fragments. (DVIDS puts CloudFront URLs in img tags — these
  // can contain "media" / "image" which our regex doesn't care about,
  // but keeps the matching surface clean.)
  const text = itemXml
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ');
  if (EXCLUDE.test(text)) return false;
  return INCLUDE.test(text);
}

export default async function handler(request) {
  const u = new URL(request.url);
  const type = u.searchParams.get('type') === 'image' ? 'image' : 'news';
  const upstreamUrl = UPSTREAM[type];

  try {
    const r = await fetch(upstreamUrl, { headers: BROWSER_HEADERS, cache: 'no-store' });
    if (!r.ok) return text(`Upstream ${r.status}`, 502);
    const xml = await r.text();

    const items = splitItems(xml).filter(keepItem);

    const channelTitle = type === 'image'
      ? 'DVIDS · CENTCOM (imagery)'
      : 'DVIDS · CENTCOM (news)';
    const channelDesc = type === 'image'
      ? 'CENTCOM AOR imagery from DVIDS, filtered server-side'
      : 'CENTCOM AOR news from DVIDS, filtered server-side';

    const out =
`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<title>${esc(channelTitle)}</title>
<link>${esc(upstreamUrl)}</link>
<description>${esc(channelDesc)}</description>
<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items.map((it) => `<item>${it}</item>`).join('\n')}
</channel>
</rss>`;

    return new Response(out, {
      status: 200,
      headers: {
        'content-type': 'application/rss+xml; charset=utf-8',
        'access-control-allow-origin': '*',
        // Twice-daily refresh, matches /api/news per-host override for DVIDS
        'cache-control': 'public, s-maxage=43200, stale-while-revalidate=43200',
        // Lightly informative — helps when debugging from curl
        'x-dvids-source': upstreamUrl,
        'x-dvids-kept': String(items.length),
      },
    });
  } catch (e) {
    return text(`Fetch error: ${String(e?.message || e).slice(0, 200)}`, 502);
  }
}

function text(body, status) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
  });
}
